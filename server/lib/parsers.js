// Analyse des sorties de lsblk, blkid, apfsutil et /proc/self/mountinfo.
// Fonctions pures : testées dans test/parsers.test.js avec des sorties réelles du NAS.

// Partitions techniques jamais montrées aux utilisateurs.
const HIDDEN_PARTTYPES = new Set([
  'c12a7328-f81f-11d2-ba4b-00a0c93ec93b', // EFI System
  '426f6f74-0000-11aa-aa11-00306543ecac', // Apple Boot (Recovery HD)
  'e3c9e316-0b5c-4db8-817d-f92df00215ae', // Microsoft Reserved
  'de94bba4-06d1-4d40-a16a-bfd50179d6ac', // Windows Recovery
  '0xef',                                 // EFI (MBR)
]);

// Sans udev (dans un conteneur), lsblk ne connaît ni le format ni le type de partition :
// on revérifie donc aussi après blkid.
function isHiddenPartition(parttype, fsType) {
  if (parttype && HIDDEN_PARTTYPES.has(String(parttype).toLowerCase())) return true;
  return ['swap', 'linux_raid_member', 'LVM2_member'].includes(fsType);
}

/**
 * Transforme `lsblk -J -b -o NAME,PATH,SIZE,FSTYPE,LABEL,UUID,TRAN,PKNAME,TYPE,
 * HOTPLUG,MODEL,VENDOR,PARTTYPE,PARTLABEL` en liste de disques USB avec leurs
 * partitions utilisables.
 */
function parseLsblk(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const disks = [];
  for (const dev of data.blockdevices || []) {
    if (dev.type !== 'disk') continue;
    const isUsb = dev.tran === 'usb' || (dev.hotplug === true && !['sata', 'nvme', 'ata'].includes(dev.tran));
    if (!isUsb) continue;
    const children = dev.children || [];
    if (children.some(c => c.fstype === 'linux_raid_member')) continue;

    const model = [dev.vendor, dev.model].map(s => (s || '').trim()).filter(Boolean).join(' ') || 'Disque USB';
    const candidates = children.length ? children.filter(c => c.type === 'part') : (dev.fstype ? [dev] : []);
    const partitions = [];
    for (const p of candidates) {
      if (isHiddenPartition(p.parttype, p.fstype)) continue;
      if (Number(p.size) < 1024 * 1024) continue;
      partitions.push({
        dev: p.path,
        name: p.name,
        size: Number(p.size),
        fsType: p.fstype || null,
        label: p.label || p.partlabel || null,
        uuid: p.uuid || null,
        parttype: (p.parttype || '').toLowerCase() || null,
      });
    }
    disks.push({ name: dev.name, dev: dev.path, model, size: Number(dev.size), partitions });
  }
  return disks;
}

/** `blkid -p -o export <dev>` → { TYPE, UUID, LABEL, ... } */
function parseBlkidExport(text) {
  const out = {};
  for (const line of (text || '').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).replace(/\\(.)/g, '$1');
  }
  return out;
}

// Rôles APFS techniques (volumes système macOS) masqués aux utilisateurs.
const HIDDEN_APFS_ROLES = /^(Preboot|Recovery|VM|Update|Hardware|xART|Baseband|Prelogin|System|Installer)/i;

/** Sortie texte de `apfsutil <dev>` → volumes. */
function parseApfsutil(text) {
  const volumes = [];
  const blocks = (text || '').split(/^(?=Volume \d+ )/m);
  for (const block of blocks) {
    const head = block.match(/^Volume (\d+) ([0-9A-Fa-f-]+)/);
    if (!head) continue;
    const field = (name) => {
      const m = block.match(new RegExp(`^${name}:\\s*(.*)$`, 'm'));
      return m ? m[1].trim() : '';
    };
    const rawName = field('Name');
    const role = field('Role');
    volumes.push({
      index: Number(head[1]),
      uuid: head[2].toUpperCase(),
      name: rawName.replace(/\s*\(Case-(in)?sensitive\)\s*$/i, ''),
      role,
      encrypted: /^yes/i.test(field('FileVault')),
      used: Number((field('Capacity Consumed').match(/\d+/) || [0])[0]),
      hidden: HIDDEN_APFS_ROLES.test(role),
    });
  }
  return volumes;
}

/** /proc/self/mountinfo → [{ target, fsType, source }] */
function parseMountinfo(text) {
  const unescape = s => s.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
  const mounts = [];
  for (const line of (text || '').split('\n')) {
    if (!line.trim()) continue;
    const [left, right] = line.split(' - ');
    if (!right) continue;
    const l = left.split(' ');
    const r = right.split(' ');
    mounts.push({ target: unescape(l[4]), fsType: r[0], source: unescape(r[1]) });
  }
  return mounts;
}

module.exports = { parseLsblk, parseBlkidExport, parseApfsutil, parseMountinfo, isHiddenPartition };
