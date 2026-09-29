const fs = require('fs');
const path = require('path');
const platform = require('./platformService');
const { validateTargetSpec } = require('../lib/targetPath');
const { t } = require('../lib/i18n');

// Destinations proposées à l'utilisateur, par nom :
//   - dossiers de groupe Nextcloud (app « Group folders ») et dossiers personnels des utilisateurs ;
//   - dossiers simples montés sous TB_DESTINATIONS_ROOT (/destinations par défaut), utilisables
//     sans Nextcloud : copie seule, sans indexation.

const DESTINATIONS_ROOT = process.env.TB_DESTINATIONS_ROOT || '/destinations';

/** groupfolders:list --output=json (tableau ou objet selon la version de l'app). */
function parseGroupFolders(json) {
  const items = Array.isArray(json) ? json : Object.values(json || {});
  return items
    .map(g => ({ id: String(g.id ?? g.folder_id ?? ''), name: g.mount_point ?? g.mountPoint ?? g.name ?? '' }))
    .filter(g => /^\d+$/.test(g.id))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/** user:list --output=json : { uid: "Nom affiché" } */
function parseUsers(json) {
  return Object.entries(json || {})
    .map(([id, name]) => ({ id, name: typeof name === 'string' && name ? name : id }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/** Sous-dossiers de premier niveau de TB_DESTINATIONS_ROOT (chacun est une destination). */
function listFolderDestinations(root = DESTINATIONS_ROOT) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => ({ id: e.name, name: e.name }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  } catch (_) { return []; }
}

async function list() {
  const out = { groups: [], users: [], folders: listFolderDestinations() };
  const p = await platform.detect();
  if (!p.nextcloud) return out;
  if (p.apps.groupfolders) {
    const r = await platform.occ(['groupfolders:list', '--output=json'], { timeout: 60000 });
    try { out.groups = parseGroupFolders(platform.parseJsonOutput(r.stdout)); } catch (_) {}
  }
  const u = await platform.occ(['user:list', '--output=json'], { timeout: 60000 });
  try { out.users = parseUsers(platform.parseJsonOutput(u.stdout)); } catch (_) {}
  return out;
}

function ownerOf(dir) {
  const forced = process.env.TB_OWNER;
  if (forced) {
    const [uid, gid] = forced.split(':').map(Number);
    return { uid, gid: Number.isFinite(gid) ? gid : uid };
  }
  const st = fs.statSync(dir);
  return { uid: st.uid, gid: st.gid };
}

/**
 * Destination → chemins, propriétaire des fichiers et indexation.
 * {
 *   type, id, subPath, label,
 *   filesRoot : racine de la destination (dans TransBack),
 *   root      : filesRoot + subPath,
 *   owner     : { uid, gid } appliqué aux fichiers copiés,
 *   indexed   : true si Nextcloud doit indexer la copie,
 * }
 */
async function resolve(spec, { known } = {}) {
  const s = validateTargetSpec(spec);

  if (s.type === 'folder') {
    const lists = known || { folders: listFolderDestinations() };
    const f = (lists.folders || []).find(x => x.id === s.id);
    if (!f) throw new Error(t('err.targetUnknown'));
    const filesRoot = path.join(DESTINATIONS_ROOT, s.id);
    // Les fichiers prennent le propriétaire du dossier de destination
    return { ...s, label: f.name, filesRoot, root: s.subPath ? path.join(filesRoot, s.subPath) : filesRoot, owner: ownerOf(filesRoot), indexed: false };
  }

  const p = await platform.requireReady();
  const data = p.dataDir.inTransback;
  const lists = known || await list();

  let filesRoot, label;
  if (s.type === 'group') {
    const g = lists.groups.find(x => x.id === s.id);
    if (!g) throw new Error(t('err.targetUnknown'));
    // Selon la version de l'app, les fichiers sont dans __groupfolders/<id>/files ou __groupfolders/<id>
    const withFiles = path.join(data, '__groupfolders', s.id, 'files');
    filesRoot = fs.existsSync(withFiles) ? withFiles : path.join(data, '__groupfolders', s.id);
    label = g.name;
  } else {
    const u = lists.users.find(x => x.id === s.id);
    if (!u) throw new Error(t('err.targetUnknown'));
    filesRoot = path.join(data, s.id, 'files');
    label = u.name;
  }
  if (!fs.existsSync(filesRoot)) throw new Error(t('err.targetMissingOnDisk', { path: filesRoot }));
  return { ...s, label, filesRoot, root: s.subPath ? path.join(filesRoot, s.subPath) : filesRoot, owner: p.webUser, indexed: true };
}

/** Commande occ d'indexation pour un chemin relatif à filesRoot (null : pas d'indexation). */
function scanArgs(target, rel) {
  if (target.type === 'group') {
    return rel ? ['groupfolders:scan', target.id, '--path', rel] : ['groupfolders:scan', target.id];
  }
  if (target.type === 'user') {
    return ['files:scan', `--path=/${target.id}/files${rel ? '/' + rel : ''}`];
  }
  return null;
}

module.exports = { list, resolve, scanArgs, parseGroupFolders, parseUsers, listFolderDestinations, DESTINATIONS_ROOT };
