const test = require('node:test');
const assert = require('node:assert');
const { parseLsblk, parseBlkidExport, parseApfsutil, parseMountinfo } = require('../server/lib/parsers');

// Sortie réelle d'un NAS Ugreen (disque RAID interne + disque Seagate APFS en USB).
const LSBLK = {
  blockdevices: [
    {
      name: 'sda', path: '/dev/sda', size: 20000588955648, fstype: null, label: null, uuid: null,
      tran: 'sata', pkname: null, type: 'disk', hotplug: false, model: 'ST20000NM', vendor: 'ATA',
      children: [
        { name: 'sda1', path: '/dev/sda1', size: 16382951424, fstype: null, type: 'part' },
        { name: 'sda2', path: '/dev/sda2', size: 19984203907072, fstype: 'linux_raid_member', label: 'UGREEN-DATA-x86_64-5128BF', type: 'part' },
      ],
    },
    {
      name: 'sdg', path: '/dev/sdg', size: 16000900660736, fstype: null, label: null, uuid: null,
      tran: 'usb', pkname: null, type: 'disk', hotplug: true, model: 'Expansion HDD   ', vendor: 'Seagate ',
      children: [
        { name: 'sdg1', path: '/dev/sdg1', size: 209715200, fstype: 'vfat', label: 'EFI', uuid: '67E3-17ED', type: 'part', parttype: 'c12a7328-f81f-11d2-ba4b-00a0c93ec93b' },
        { name: 'sdg2', path: '/dev/sdg2', size: 16000689876992, fstype: 'apfs', label: null, uuid: '5e427d2d-5bc3-487d-bd05-85d7f921f053', type: 'part', parttype: '7c3457ef-0000-11aa-aa11-00306543ecac' },
      ],
    },
    {
      // Clé USB formatée sans table de partitions (« superfloppy »)
      name: 'sdh', path: '/dev/sdh', size: 4000000000, fstype: 'vfat', label: 'VIEUXMAC', uuid: '1234-ABCD',
      tran: 'usb', type: 'disk', hotplug: true, model: 'Flash', vendor: 'Generic',
    },
  ],
};

test('parseLsblk : garde les disques USB, masque EFI et le RAID', () => {
  const disks = parseLsblk(LSBLK);
  assert.deepStrictEqual(disks.map(d => d.name), ['sdg', 'sdh']);
  const sdg = disks[0];
  assert.strictEqual(sdg.model, 'Seagate Expansion HDD');
  assert.deepStrictEqual(sdg.partitions.map(p => p.dev), ['/dev/sdg2']);
  assert.strictEqual(sdg.partitions[0].fsType, 'apfs');
});

test('parseLsblk : disque sans partition utilisé directement', () => {
  const sdh = parseLsblk(LSBLK)[1];
  assert.strictEqual(sdh.partitions.length, 1);
  assert.strictEqual(sdh.partitions[0].dev, '/dev/sdh');
  assert.strictEqual(sdh.partitions[0].label, 'VIEUXMAC');
});

test('parseBlkidExport', () => {
  const info = parseBlkidExport('DEVNAME=/dev/sdg2\nUUID=5e427d2d\nTYPE=apfs\nPART_ENTRY_NAME=EFI\\ System\\ Partition\n');
  assert.strictEqual(info.TYPE, 'apfs');
  assert.strictEqual(info.PART_ENTRY_NAME, 'EFI System Partition');
});

// Sortie réelle de apfsutil sur le disque « Archives », plus un volume système fictif.
const APFSUTIL = `Volume 0 15C373E4-24C3-4C8B-B810-299C8987061A
---------------------------------------------
Role:               No specific role
Name:               Archives 2022 @ 2026 (Case-insensitive)
Capacity Consumed:  10621643554816 Bytes
FileVault:          No
Snapshots:

Volume 1 AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE
---------------------------------------------
Role:               Preboot
Name:               Preboot (Case-insensitive)
Capacity Consumed:  1000 Bytes
FileVault:          No

Volume 2 11111111-2222-3333-4444-555555555555
---------------------------------------------
Role:               No specific role
Name:               Secret (Case-sensitive)
Capacity Consumed:  42 Bytes
FileVault:          Yes
`;

test('parseApfsutil : nom, rôle, chiffrement', () => {
  const vols = parseApfsutil(APFSUTIL);
  assert.strictEqual(vols.length, 3);
  assert.deepStrictEqual(vols[0], {
    index: 0, uuid: '15C373E4-24C3-4C8B-B810-299C8987061A',
    name: 'Archives 2022 @ 2026', role: 'No specific role',
    encrypted: false, used: 10621643554816, hidden: false,
  });
  assert.strictEqual(vols[1].hidden, true);
  assert.strictEqual(vols[2].encrypted, true);
  assert.strictEqual(vols[2].name, 'Secret');
});

test('parseMountinfo : chemins avec espaces échappés', () => {
  const text = '36 25 0:32 / /mnt/usb/sdg1 ro,relatime shared:1 - vfat /dev/sdg1 rw,fmask=0000\n'
    + '40 25 0:50 / /mnt/tb/Mon\\040Disque rw - fuse.apfs-fuse /dev/sdg2 rw,user_id=0\n';
  const mounts = parseMountinfo(text);
  assert.deepStrictEqual(mounts[0], { target: '/mnt/usb/sdg1', fsType: 'vfat', source: '/dev/sdg1' });
  assert.strictEqual(mounts[1].target, '/mnt/tb/Mon Disque');
});
