const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { parseLsblk, parseBlkidExport, parseApfsutil, parseMountinfo, isHiddenPartition } = require('../lib/parsers');
const { t } = require('../lib/i18n');

// Disques déjà montés par l'hôte (s'ils sont visibles dans le conteneur, n'importe où)
// ou montés par TransBack lui-même sous MOUNT_ROOT.
const MOUNT_ROOT = process.env.TB_MOUNT_ROOT || '/mnt/tb';

const LSBLK_COLS = 'NAME,PATH,SIZE,FSTYPE,LABEL,UUID,TRAN,PKNAME,TYPE,HOTPLUG,MODEL,VENDOR,PARTTYPE,PARTLABEL';

// Options de montage (lecture seule) par format, essayées dans l'ordre.
const MOUNT_PLANS = {
  hfsplus:  { type: 'hfsplus', modules: ['hfsplus', 'nls_utf8'], options: ['ro,nosuid,nodev'] },
  hfs:      { type: 'hfs',     modules: ['hfs', 'nls_utf8', 'nls_macroman'], options: ['ro,nosuid,nodev,iocharset=utf8,codepage=macroman', 'ro,nosuid,nodev,iocharset=utf8', 'ro,nosuid,nodev'] },
  vfat:     { type: 'vfat',    modules: ['vfat', 'nls_utf8', 'nls_cp850'], options: ['ro,nosuid,nodev,iocharset=utf8,codepage=850', 'ro,nosuid,nodev,utf8', 'ro,nosuid,nodev'] },
  exfat:    { type: 'exfat',   modules: ['exfat', 'nls_utf8'], options: ['ro,nosuid,nodev,iocharset=utf8', 'ro,nosuid,nodev'] },
  ntfs:     { type: 'ntfs3',   modules: ['ntfs3', 'nls_utf8'], options: ['ro,nosuid,nodev,iocharset=utf8', 'ro,nosuid,nodev'] },
  ntfs3:    { type: 'ntfs3',   modules: ['ntfs3', 'nls_utf8'], options: ['ro,nosuid,nodev,iocharset=utf8', 'ro,nosuid,nodev'] },
  iso9660:  { type: 'iso9660', modules: ['isofs', 'nls_utf8'], options: ['ro,nosuid,nodev,iocharset=utf8', 'ro,nosuid,nodev'] },
  udf:      { type: 'udf',     modules: ['udf', 'nls_utf8'], options: ['ro,nosuid,nodev,iocharset=utf8', 'ro,nosuid,nodev'] },
  ext2:     { type: 'ext2',    modules: [], options: ['ro,nosuid,nodev'] },
  ext3:     { type: 'ext3',    modules: [], options: ['ro,nosuid,nodev,noload', 'ro,nosuid,nodev'] },
  ext4:     { type: 'ext4',    modules: [], options: ['ro,nosuid,nodev,noload', 'ro,nosuid,nodev'] },
  btrfs:    { type: 'btrfs',   modules: [], options: ['ro,nosuid,nodev'] },
  xfs:      { type: 'xfs',     modules: ['xfs'], options: ['ro,nosuid,nodev,norecovery', 'ro,nosuid,nodev'] },
};

// Libellés des formats (clés de traduction)
const FS_LABELS = Object.fromEntries(
  ['apfs', 'hfsplus', 'hfs', 'vfat', 'exfat', 'ntfs', 'ntfs3', 'iso9660', 'udf', 'ext2', 'ext3', 'ext4', 'btrfs', 'xfs']
    .map(k => [k, `fs.${k === 'ntfs3' ? 'ntfs' : k}`])
);

// ── État ────────────────────────────────────────────────────────────────────
let volumes = new Map();        // id → volume
let disks = [];                 // dernière détection
const ejectedDisks = new Set(); // disques éjectés : pas de remontage auto tant qu'ils restent branchés
const apfsCache = new Map();    // "dev|uuid" → sortie apfsutil
let lock = Promise.resolve();

function withLock(fn) {
  const run = lock.then(fn, fn);
  lock = run.catch(() => {});
  return run;
}

function run(cmd, args, timeout = 30000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: stdout || '', stderr: (stderr || '').trim() || (err ? err.message : '') });
    });
  });
}

async function readMounts() {
  try { return parseMountinfo(await fs.promises.readFile('/proc/self/mountinfo', 'utf8')); }
  catch (_) { return []; }
}

function safeId(s) {
  return String(s).replace(/[^A-Za-z0-9-]/g, '_');
}

// Vérifie qu'un point de montage répond (un disque débranché sans éjection laisse
// un montage mort : ENOTCONN pour FUSE, EIO pour le noyau).
function isAlive(dir, timeout = 5000) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(false); } }, timeout);
    fs.promises.readdir(dir)
      .then(() => { if (!done) { done = true; clearTimeout(timer); resolve(true); } })
      .catch(() => { if (!done) { done = true; clearTimeout(timer); resolve(false); } });
  });
}

async function unmount(target, lazy = false) {
  const args = lazy ? ['-l', target] : [target];
  let r = await run('umount', args);
  if (!r.ok) r = await run('fusermount3', [lazy ? '-uz' : '-u', target]);
  return r;
}

async function modprobe(modules) {
  for (const m of modules) await run('modprobe', ['-q', m], 10000);
}

// ── Montage ─────────────────────────────────────────────────────────────────
async function mountKernel(dev, fsType, target) {
  const plan = MOUNT_PLANS[fsType];
  if (!plan) return { ok: false, reason: t('disk.unsupported', { fs: fsType || '?' }) };
  await modprobe(plan.modules);
  await fs.promises.mkdir(target, { recursive: true });
  let last = '';
  for (const opts of plan.options) {
    const r = await run('mount', ['-t', plan.type, '-o', opts, dev, target], 60000);
    if (r.ok) return { ok: true };
    last = r.stderr;
  }
  await fs.promises.rmdir(target).catch(() => {});
  return { ok: false, reason: t('disk.mountFailed', { error: last }) };
}

async function mountApfsVolume(dev, index, target) {
  await fs.promises.mkdir(target, { recursive: true });
  const r = await run('apfs-fuse', ['-o', 'allow_other', '-v', String(index), dev, target], 60000);
  if (r.ok) return { ok: true };
  await fs.promises.rmdir(target).catch(() => {});
  return { ok: false, reason: t('disk.apfsFailed', { error: r.stderr }) };
}

// ── Détection ───────────────────────────────────────────────────────────────
// Dans le conteneur, lsblk (sans udev) ne voit pas le format : blkid sonde le disque directement.
async function probe(part) {
  const r = await run('blkid', ['-p', '-o', 'export', part.dev], 15000);
  const info = parseBlkidExport(r.stdout);
  return {
    ...part,
    fsType: part.fsType || info.TYPE || null,
    label: part.label || info.LABEL || info.PART_ENTRY_NAME || null,
    uuid: part.uuid || info.UUID || null,
    parttype: part.parttype || (info.PART_ENTRY_TYPE || '').toLowerCase() || null,
  };
}

async function buildVolumes(disk, mounts, hostByDev) {
  const out = [];
  let partNumber = 0;
  for (const raw of disk.partitions) {
    partNumber++;
    const part = await probe(raw);
    if (isHiddenPartition(part.parttype, part.fsType)) continue;
    const base = {
      diskName: disk.name,
      dev: part.dev,
      fsType: part.fsType,
      fsLabel: FS_LABELS[part.fsType] ? t(FS_LABELS[part.fsType]) : (part.fsType || t('disk.fsUnknown')),
      size: part.size,
    };

    if (part.fsType === 'apfs') {
      const cacheKey = `${part.dev}|${part.uuid}`;
      let r = apfsCache.get(cacheKey);
      if (!r) {
        r = await run('apfsutil', [part.dev], 60000);
        if (r.ok) apfsCache.set(cacheKey, r);
      }
      const apfsVols = parseApfsutil(r.stdout).filter(v => !v.hidden);
      if (!r.ok && !apfsVols.length) {
        out.push({ ...base, id: safeId(`p-${part.uuid || part.name}`), label: part.label || t('disk.partitionLabel', { model: disk.model, n: partNumber }), supported: false, reason: t('disk.apfsFailed', { error: r.stderr }) });
        continue;
      }
      for (const v of apfsVols) {
        const id = safeId(`apfs-${v.uuid}`);
        out.push({
          ...base, id, apfsIndex: v.index, size: v.used || part.size,
          label: v.name || t('disk.volumeLabel', { model: disk.model, n: v.index }),
          supported: !v.encrypted,
          reason: v.encrypted ? t('disk.encrypted') : null,
          mountpoint: path.join(MOUNT_ROOT, id), subRoot: 'root', managed: true,
        });
      }
      continue;
    }

    const id = safeId(`p-${part.uuid || part.name}`);
    const label = part.label || t('disk.partitionLabel', { model: disk.model, n: partNumber });
    const hostMount = hostByDev.get(part.dev);
    if (hostMount) {
      out.push({ ...base, id, label, supported: true, reason: null, mountpoint: hostMount, subRoot: '', managed: false });
    } else if (MOUNT_PLANS[part.fsType]) {
      out.push({ ...base, id, label, supported: true, reason: null, mountpoint: path.join(MOUNT_ROOT, id), subRoot: '', managed: true });
    } else {
      out.push({ ...base, id, label, supported: false, reason: t('disk.unsupported', { fs: part.fsType || t('disk.fsNone') }) });
    }
  }
  return out;
}

async function ensureMounted(vol, mounts) {
  if (!vol.supported) return;
  const mounted = mounts.some(m => m.target === vol.mountpoint);
  if (mounted) {
    if (await isAlive(vol.mountpoint)) { vol.mounted = true; return; }
    if (!vol.managed) { vol.mounted = false; vol.reason = t('disk.hostMountDead'); return; }
    await unmount(vol.mountpoint, true);
  }
  if (!vol.managed) { vol.mounted = false; vol.reason = t('disk.hostMountGone'); return; }

  const r = vol.fsType === 'apfs'
    ? await mountApfsVolume(vol.dev, vol.apfsIndex, vol.mountpoint)
    : await mountKernel(vol.dev, vol.fsType, vol.mountpoint);
  vol.mounted = r.ok;
  if (!r.ok) { vol.supported = false; vol.reason = r.reason; }
}

// Démonte nos montages dont le disque a disparu (débranché sans éjection).
async function cleanupOrphans(mounts, liveDevs) {
  for (const m of mounts) {
    if (!m.target.startsWith(MOUNT_ROOT + '/')) continue;
    const devGone = m.source.startsWith('/dev/') && !liveDevs.has(m.source);
    const known = [...volumes.values()].find(v => v.mountpoint === m.target);
    const stale = devGone || (known && !liveDevs.has(known.dev)) || !(await isAlive(m.target));
    if (stale) {
      await unmount(m.target, true);
      await fs.promises.rmdir(m.target).catch(() => {});
    }
  }
}

/** Détecte les disques USB, monte automatiquement ceux qui sont pris en charge. */
function refresh() {
  return withLock(async () => {
    const r = await run('lsblk', ['-J', '-b', '-o', LSBLK_COLS], 20000);
    const found = r.ok ? parseLsblk(r.stdout) : [];
    const liveDevs = new Set(found.flatMap(d => d.partitions.map(p => p.dev)));

    let mounts = await readMounts();
    await cleanupOrphans(mounts, liveDevs);
    mounts = await readMounts();

    // Montages déjà faits par l'hôte (ex. /mnt/@usb sur UGOS, /volumeUSB1 sur Synology),
    // visibles si le dossier est monté dans le conteneur : on les réutilise.
    const hostByDev = new Map();
    for (const m of mounts) {
      if (liveDevs.has(m.source) && !m.target.startsWith(MOUNT_ROOT + '/') && !hostByDev.has(m.source)) hostByDev.set(m.source, m.target);
    }

    // Un disque éjecté redevient montable une fois débranché.
    for (const name of [...ejectedDisks]) {
      if (!found.some(d => d.name === name)) ejectedDisks.delete(name);
    }
    for (const key of [...apfsCache.keys()]) {
      if (!liveDevs.has(key.split('|')[0])) apfsCache.delete(key);
    }

    const next = new Map();
    const result = [];
    for (const disk of found) {
      const vols = await buildVolumes(disk, mounts, hostByDev);
      const ejected = ejectedDisks.has(disk.name);
      for (const v of vols) {
        if (ejected) { v.mounted = false; }
        else { await ensureMounted(v, mounts); }
        next.set(v.id, v);
      }
      result.push({ name: disk.name, model: disk.model, size: disk.size, ejected, volumes: vols });
    }
    volumes = next;
    disks = result;
    return publicDisks();
  });
}

function publicDisks() {
  return disks.map(d => ({
    name: d.name, model: d.model, size: d.size, ejected: d.ejected,
    volumes: d.volumes.map(v => ({
      id: v.id, label: v.label, fsType: v.fsType, fsLabel: v.fsLabel, size: v.size,
      supported: v.supported, mounted: !!v.mounted, reason: v.reason || null, managed: !!v.managed,
    })),
  }));
}

/** Racine navigable d'un volume monté (ex. /mnt/tb/apfs-XXX/root). */
async function getVolumeRoot(id) {
  let vol = volumes.get(id);
  if (!vol || !vol.mounted) {
    await refresh();
    vol = volumes.get(id);
  }
  if (!vol) throw new Error(t('disk.notFound'));
  if (!vol.mounted) throw new Error(vol.reason || t('disk.notMounted', { label: vol.label }));
  return { root: vol.subRoot ? path.join(vol.mountpoint, vol.subRoot) : vol.mountpoint, volume: vol };
}

function getVolume(id) {
  return volumes.get(id) || null;
}

/** Éjecte tous les volumes d'un disque physique. `isBusy(volumeIds)` vient de la file d'attente. */
function eject(diskName, isBusy) {
  return withLock(async () => {
    const disk = disks.find(d => d.name === diskName);
    if (!disk) throw new Error(t('disk.notFound'));
    const ids = disk.volumes.map(v => v.id);
    const busy = isBusy(ids);
    if (busy) throw Object.assign(new Error(busy), { status: 409 });

    await run('sync', [], 60000);
    const failures = [];
    for (const v of disk.volumes) {
      if (!v.managed || !v.mounted) continue;
      const r = await unmount(v.mountpoint);
      if (r.ok) { v.mounted = false; await fs.promises.rmdir(v.mountpoint).catch(() => {}); }
      else failures.push(`${v.label} : ${r.stderr}`);
    }
    if (failures.length) {
      throw new Error(t('eject.incomplete', { details: failures.join(' ; ') }));
    }
    ejectedDisks.add(disk.name);
    disk.ejected = true;
    return { success: true, message: t('eject.done', { model: disk.model }) };
  });
}

module.exports = { refresh, publicDisks, getVolumeRoot, getVolume, eject };
