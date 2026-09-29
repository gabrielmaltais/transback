const fs = require('fs');
const path = require('path');
const dockerApi = require('../lib/dockerApi');
const { mapBetween } = require('../lib/mounts');
const { t } = require('../lib/i18n');

// Détection automatique de l'environnement : conteneur Nextcloud, occ, utilisateur web,
// dossier de données (traduit dans TransBack), applications, formats de disques.
// Tout est mis en cache ; `detect({ force: true })` relance la détection (Paramètres).

// Emplacements connus de occ selon l'image (officielle / AIO, puis linuxserver.io).
const OCC_CANDIDATES = ['/var/www/html/occ', '/app/www/public/occ', '/config/www/nextcloud/occ'];
// Conteneurs « satellites » d'une installation Nextcloud, jamais le serveur principal.
const NOT_SERVER = /(cron|notify|push|collabora|office|onlyoffice|redis|db|postgres|mariadb|mysql|clamav|imaginary|talk|whiteboard|fulltext|elastic|apache-proxy|borg|backup|coturn|mastercontainer)/i;

let cache = null;
let pending = null;

function nextcloudCandidates(containers, forced) {
  if (forced) return containers.filter(c => c.name === forced || c.id.startsWith(forced));
  return containers
    .filter(c => /nextcloud/i.test(c.image) || /nextcloud/i.test(c.name))
    .filter(c => !NOT_SERVER.test(c.name.replace(/nextcloud/ig, '')))
    // Le nom le plus court d'abord : « nextcloud » avant « nextcloud-aio-nextcloud-cron »
    .sort((a, b) => a.name.length - b.name.length);
}

async function findOcc(container) {
  for (const occPath of OCC_CANDIDATES) {
    const r = await dockerApi.exec(container, ['test', '-f', occPath], { timeout: 15000 });
    if (r.ok) return occPath;
  }
  return null;
}

function makeOcc(container, occPath, user) {
  const occ = (args, opts = {}) => dockerApi.exec(container, ['php', occPath, ...args], { user, timeout: opts.timeout || 120000 });
  occ.spawn = (args) => dockerApi.spawnExec(container, ['php', occPath, ...args], { user });
  return occ;
}

function parseJsonOutput(text) {
  // occ peut afficher des avertissements PHP avant le JSON
  const i = text.search(/[[{]/);
  return JSON.parse(i > 0 ? text.slice(i) : text);
}

function readSupportedFs() {
  let fsList = [];
  try {
    fsList = fs.readFileSync('/proc/filesystems', 'utf8').split('\n').map(l => l.trim().split(/\s+/).pop()).filter(Boolean);
  } catch (_) {}
  let modules = [];
  try {
    const dir = `/lib/modules/${require('os').release()}/kernel/fs`;
    modules = fs.readdirSync(dir);
  } catch (_) {}
  const has = (name, mod) => fsList.includes(name) || modules.includes(mod || name);
  let apfs = false;
  try { fs.accessSync('/usr/local/bin/apfs-fuse', fs.constants.X_OK); apfs = has('fuse'); } catch (_) {}
  return {
    apfs, hfsplus: has('hfsplus'), hfs: has('hfs'), vfat: has('vfat', 'fat'), exfat: has('exfat'),
    ntfs: has('ntfs3'), iso9660: has('iso9660', 'isofs'), udf: has('udf'), ext4: has('ext4'),
    modulesMounted: modules.length > 0,
  };
}

async function detectNextcloud(result, add, msg, optional) {
  // ── Docker ──────────────────────────────────────────────────────────────
  let containers;
  try {
    containers = await dockerApi.listContainers();
    add('docker', true, msg('diag.docker.ok'));
  } catch (err) {
    add('docker', false, msg('diag.docker.fail', { error: err.message }), msg('diag.docker.fix'), optional ? 'info' : 'error');
    return;
  }

  // ── Conteneur Nextcloud + occ ──────────────────────────────────────────
  const forced = process.env.NEXTCLOUD_CONTAINER || '';
  // On teste tous les candidats : s'il y a plusieurs serveurs Nextcloud sur la machine,
  // on ne choisit pas en silence, le diagnostic le signale.
  const found = [];
  for (const c of nextcloudCandidates(containers, forced)) {
    const p = await findOcc(c.name);
    if (p) found.push({ container: c, occPath: p });
  }
  if (!found.length) {
    add('nextcloud', false, forced ? msg('diag.nc.forcedMissing', { name: forced }) : msg(optional ? 'diag.nc.notFoundOptional' : 'diag.nc.notFound'), msg('diag.nc.fix'), optional ? 'info' : 'error');
    return;
  }
  const { container, occPath } = found[0];
  if (found.length > 1) {
    add('nextcloudMultiple', false,
      msg('diag.nc.multiple', { list: found.map(f => f.container.name).join(', '), name: container.name }),
      msg('diag.nc.multipleFix'), 'warn');
  }

  // ── Utilisateur web (propriétaire de config.php) ─────────────────────────
  const cfg = path.posix.join(path.posix.dirname(occPath), 'config', 'config.php');
  const st = await dockerApi.exec(container.name, ['stat', '-c', '%u:%g', cfg], { timeout: 15000 });
  const [uid, gid] = (st.ok ? st.stdout.trim() : '33:33').split(':').map(Number);
  const forcedOwner = process.env.TB_OWNER; // « uid:gid »
  result.webUser = forcedOwner
    ? { uid: Number(forcedOwner.split(':')[0]), gid: Number(forcedOwner.split(':')[1] || forcedOwner.split(':')[0]) }
    : { uid, gid };
  const occ = makeOcc(container.name, occPath, `${result.webUser.uid}:${result.webUser.gid}`);

  const status = await occ(['status', '--output=json'], { timeout: 60000 });
  let version = '?';
  try { version = parseJsonOutput(status.stdout).versionstring || '?'; } catch (_) {}
  if (!status.ok) {
    add('nextcloud', false, msg('diag.nc.occFail', { name: container.name, error: status.stderr.slice(0, 300) }), msg('diag.nc.occFix'), optional ? 'warn' : 'error');
    return;
  }
  result.nextcloud = { container: container.name, image: container.image, occPath, version, occ };
  add('nextcloud', true, msg('diag.nc.ok', { name: container.name, version, image: container.image }));
  add('owner', true, msg('diag.owner.ok', { uid: result.webUser.uid, gid: result.webUser.gid }));

  // ── Dossier de données : Nextcloud → hôte → TransBack ───────────────────
  const dd = await occ(['config:system:get', 'datadirectory'], { timeout: 30000 });
  const dataInNc = dd.ok && dd.stdout.trim() ? dd.stdout.trim() : '/var/www/html/data';
  try {
    const [ncInfo, selfInfo] = await Promise.all([dockerApi.inspect(container.id), dockerApi.inspect(dockerApi.selfContainerId())]);
    const { host, mapped } = mapBetween(dataInNc, ncInfo.Mounts, selfInfo.Mounts);
    result.dataDir = { inNextcloud: dataInNc, host, inTransback: mapped };
    if (mapped && fs.existsSync(mapped)) {
      add('data', true, msg('diag.data.ok', { path: mapped, host }));
    } else if (host) {
      add('data', false, msg('diag.data.notMounted', { host }), msg('diag.data.fix', { host }), optional ? 'warn' : 'error');
    } else {
      add('data', false, msg('diag.data.noHost', { path: dataInNc }), msg('diag.data.noHostFix'), optional ? 'warn' : 'error');
    }
  } catch (err) {
    add('data', false, msg('diag.data.inspectFail', { error: err.message }), msg('diag.data.inspectFix'), optional ? 'warn' : 'error');
  }

  // ── Applications ────────────────────────────────────────────────────────
  const apps = await occ(['app:list', '--output=json'], { timeout: 60000 });
  try {
    const enabled = parseJsonOutput(apps.stdout).enabled || {};
    result.apps.groupfolders = 'groupfolders' in enabled;
  } catch (_) { result.apps.groupfolders = false; }
  add('groupfolders', true, result.apps.groupfolders ? msg('diag.gf.ok') : msg('diag.gf.missing'), null, result.apps.groupfolders ? 'ok' : 'info');

}

async function runDetection() {
  const checks = [];
  // Les messages sont stockés sous forme de clés : ils sont traduits à l'affichage,
  // dans la langue de l'interface (publicView).
  const add = (id, ok, detail, fix = null, level = ok ? 'ok' : 'error') => checks.push({ id, ok, level, detail, fix });
  const msg = (key, vars) => ({ key, vars: vars || {} });
  const result = { ok: false, checks, nextcloud: null, webUser: null, dataDir: null, apps: {}, formats: readSupportedFs(), folders: [] };

  // Dossiers de destination simples (sans Nextcloud) : s'il y en a, Nextcloud devient optionnel.
  const { listFolderDestinations, DESTINATIONS_ROOT } = require('./targetService');
  result.folders = listFolderDestinations();
  const optional = result.folders.length > 0;

  await detectNextcloud(result, add, msg, optional);

  if (optional) {
    add('folders', true, msg('diag.folders.ok', { count: result.folders.length, root: DESTINATIONS_ROOT, list: result.folders.map(f => f.name).join(', ') }));
  } else if (!result.nextcloud) {
    add('folders', false, msg('diag.folders.none', { root: DESTINATIONS_ROOT }), msg('diag.folders.fix', { root: DESTINATIONS_ROOT }), 'info');
  }

  // ── Formats de disques ──────────────────────────────────────────────────
  const f = result.formats;
  const missing = ['apfs', 'hfsplus', 'hfs', 'exfat', 'ntfs'].filter(k => !f[k]);
  add('formats', missing.length === 0,
    missing.length ? msg('diag.fs.partial', { list: missing.join(', ') }) : msg('diag.fs.ok'),
    missing.length && !f.modulesMounted ? msg('diag.fs.fix') : null,
    missing.length ? 'warn' : 'ok');

  // ── Authentification ────────────────────────────────────────────────────
  const auth = require('./authService');
  add('auth', auth.isEnabled(), auth.isEnabled() ? msg('diag.auth.ok', { mode: auth.mode() }) : msg('diag.auth.off'),
    auth.isEnabled() ? null : msg('diag.auth.fix'), auth.isEnabled() ? 'ok' : 'warn');

  result.ok = checks.every(c => c.ok || c.level !== 'error');
  return result;
}

/** Résultat de détection (mis en cache). */
function detect({ force = false } = {}) {
  if (cache && !force) return Promise.resolve(cache);
  if (!pending) {
    pending = runDetection()
      .then(r => { cache = r; return r; })
      .finally(() => { pending = null; });
  }
  return pending;
}

/** Exécute une commande occ, en lançant la détection si besoin. */
async function occ(args, opts) {
  const p = await detect();
  if (!p.nextcloud) throw new Error(t('err.ncUnavailable'));
  return p.nextcloud.occ(args, opts);
}

/** Lance occ en renvoyant le processus (sortie lue au fil de l'eau). */
async function occSpawn(args) {
  const p = await detect();
  if (!p.nextcloud) throw new Error(t('err.ncUnavailable'));
  return p.nextcloud.occ.spawn(args);
}

async function requireReady() {
  const p = await detect();
  if (!p.nextcloud) throw new Error(t('err.ncUnavailable'));
  if (!p.dataDir || !p.dataDir.inTransback || !fs.existsSync(p.dataDir.inTransback)) throw new Error(t('err.dataUnavailable'));
  return p;
}

/** Version sérialisable pour l'interface (sans la fonction occ). */
function publicView(p) {
  const tr = (m) => (m && typeof m === 'object' ? t(m.key, m.vars) : m);
  return {
    ok: p.ok,
    checks: p.checks.map(c => ({ ...c, detail: tr(c.detail), fix: tr(c.fix) })),
    nextcloud: p.nextcloud ? { container: p.nextcloud.container, image: p.nextcloud.image, version: p.nextcloud.version, occPath: p.nextcloud.occPath } : null,
    webUser: p.webUser, dataDir: p.dataDir, apps: p.apps, formats: p.formats, folders: p.folders,
  };
}

module.exports = { detect, occ, occSpawn, requireReady, publicView, parseJsonOutput, nextcloudCandidates };
