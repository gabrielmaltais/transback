const test = require('node:test');
const assert = require('node:assert');
const { containerToHost, hostToContainer, mapBetween } = require('../server/lib/mounts');
const { selfContainerId } = require('../server/lib/dockerApi');
const { parseOccCounts } = require('../server/lib/occRun');
const { parseGroupFolders, parseUsers, scanArgs } = require('../server/services/targetService');
const { nextcloudCandidates, parseJsonOutput } = require('../server/services/platformService');
const { formatBytes, parseRsyncTransferSize } = require('../server/lib/format');

// ── Montages (fixtures inspirées de vraies installations) ────────────────────
const NC_OFFICIAL = [
  { Type: 'bind', Source: '/volume1/docker/nextcloud/app', Destination: '/var/www/html' },
  { Type: 'bind', Source: '/volume1/nc_data', Destination: '/var/www/html/data' },
];
const NC_AIO = [
  { Type: 'volume', Source: '/var/lib/docker/volumes/nextcloud_aio_nextcloud/_data', Destination: '/var/www/html' },
  { Type: 'bind', Source: '/mnt/ncdata', Destination: '/mnt/ncdata' },
];
const NC_LSIO = [
  { Type: 'bind', Source: '/srv/nextcloud/config', Destination: '/config' },
  { Type: 'bind', Source: '/srv/nextcloud/data', Destination: '/data' },
];
const TB = [
  { Type: 'bind', Source: '/volume1/nc_data', Destination: '/mnt/nextcloud_data' },
  { Type: 'bind', Source: '/mnt/ncdata', Destination: '/mnt/ncdata' },
  { Type: 'bind', Source: '/srv/nextcloud/data', Destination: '/nc' },
  { Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock' },
];

test('mapBetween : image officielle (sous-montage le plus précis)', () => {
  assert.deepStrictEqual(mapBetween('/var/www/html/data', NC_OFFICIAL, TB), { host: '/volume1/nc_data', mapped: '/mnt/nextcloud_data' });
});

test('mapBetween : AIO et linuxserver', () => {
  assert.strictEqual(mapBetween('/mnt/ncdata', NC_AIO, TB).mapped, '/mnt/ncdata');
  assert.strictEqual(mapBetween('/data', NC_LSIO, TB).mapped, '/nc');
});

test('mapBetween : données non montées dans TransBack', () => {
  const r = mapBetween('/var/www/html/data', NC_OFFICIAL, [{ Source: '/elsewhere', Destination: '/x' }]);
  assert.deepStrictEqual(r, { host: '/volume1/nc_data', mapped: null });
});

test('containerToHost / hostToContainer : pas de faux préfixe', () => {
  assert.strictEqual(containerToHost('/var/www/html2', NC_OFFICIAL), null);
  assert.strictEqual(hostToContainer('/volume1/nc_data_old', TB), null);
  assert.strictEqual(hostToContainer('/volume1/nc_data/alice/files', TB), '/mnt/nextcloud_data/alice/files');
});

test('selfContainerId : lu dans mountinfo', () => {
  const id = 'a'.repeat(64);
  const mi = `620 600 0:50 /volume1/@docker/containers/${id}/hostname /etc/hostname rw - ext4 /dev/dm-0 rw\n`;
  assert.strictEqual(selfContainerId(mi), id);
});

// ── Détection du conteneur Nextcloud ─────────────────────────────────────────
test('nextcloudCandidates : écarte cron, bases de données, satellites', () => {
  const containers = [
    { id: '1', name: 'nextcloud-cron', image: 'nextcloud:33-apache' },
    { id: '2', name: 'nextcloud-app', image: 'nextcloud:33-apache' },
    { id: '3', name: 'nextcloud-db', image: 'postgres:15' },
    { id: '4', name: 'nextcloud-notify-push', image: 'nextcloud:33-apache' },
    { id: '5', name: 'nextcloud-aio-nextcloud', image: 'nextcloud/aio-nextcloud:latest' },
    { id: '6', name: 'nextcloud-aio-mastercontainer', image: 'nextcloud/all-in-one:latest' },
    { id: '7', name: 'vaultwarden', image: 'vaultwarden/server' },
  ];
  assert.deepStrictEqual(nextcloudCandidates(containers).map(c => c.name), ['nextcloud-app', 'nextcloud-aio-nextcloud']);
  assert.deepStrictEqual(nextcloudCandidates(containers, 'vaultwarden').map(c => c.name), ['vaultwarden']);
});

test('parseJsonOutput : ignore les avertissements PHP avant le JSON', () => {
  assert.deepStrictEqual(parseJsonOutput('PHP Warning: foo\n{"a":1}'), { a: 1 });
});

// ── Sorties occ ──────────────────────────────────────────────────────────────
test('parseOccCounts : groupfolders:scan (sortie réelle)', () => {
  const out = `+-----------+---------+-------+--------+--------------+
| Folder Id | Folders | Files | Errors | Elapsed time |
+-----------+---------+-------+--------+--------------+
| 1 - files | 4       | 6     | 0      | 00:00:00     |
+-----------+---------+-------+--------+--------------+`;
  assert.deepStrictEqual(parseOccCounts(out), { dirs: 4, files: 6 });
});

test('parseOccCounts : files:scan (colonnes différentes)', () => {
  const out = `+---------+-------+-----+---------+---------+--------+--------------+
| Folders | Files | New | Updated | Removed | Errors | Elapsed time |
+---------+-------+-----+---------+---------+--------+--------------+
| 3       | 10    | 10  | 0       | 0       | 0      | 00:00:01     |
+---------+-------+-----+---------+---------+--------+--------------+`;
  assert.deepStrictEqual(parseOccCounts(out), { dirs: 3, files: 10 });
  assert.strictEqual(parseOccCounts('rien'), null);
});

test('parseGroupFolders : tableau ou objet, tri par nom', () => {
  const arr = [{ id: 2, mount_point: 'Projets' }, { id: 1, mount_point: 'Archives' }];
  assert.deepStrictEqual(parseGroupFolders(arr), [{ id: '1', name: 'Archives' }, { id: '2', name: 'Projets' }]);
  assert.deepStrictEqual(parseGroupFolders({ 5: { id: 5, mount_point: 'Équipe' } }), [{ id: '5', name: 'Équipe' }]);
});

test('parseUsers', () => {
  assert.deepStrictEqual(parseUsers({ bob: 'Bob Martin', alice: '' }), [{ id: 'alice', name: 'alice' }, { id: 'bob', name: 'Bob Martin' }]);
});

test('scanArgs : commande d\'indexation selon la destination', () => {
  assert.deepStrictEqual(scanArgs({ type: 'group', id: '1' }, 'A/B'), ['groupfolders:scan', '1', '--path', 'A/B']);
  assert.deepStrictEqual(scanArgs({ type: 'group', id: '1' }, ''), ['groupfolders:scan', '1']);
  assert.deepStrictEqual(scanArgs({ type: 'user', id: 'alice' }, 'Photos'), ['files:scan', '--path=/alice/files/Photos']);
  assert.deepStrictEqual(scanArgs({ type: 'user', id: 'alice' }, ''), ['files:scan', '--path=/alice/files']);
});

// ── Taille et formatage ──────────────────────────────────────────────────────
test('parseRsyncTransferSize', () => {
  assert.strictEqual(parseRsyncTransferSize('Number of files: 3\nTotal transferred file size: 13,349,812,345 bytes\n'), 13349812345);
  assert.strictEqual(parseRsyncTransferSize('Total transferred file size: 0 bytes'), 0);
  assert.strictEqual(parseRsyncTransferSize('erreur'), null);
});

test('formatBytes', () => {
  assert.strictEqual(formatBytes(0), '0 B');
  assert.strictEqual(formatBytes(13349812345, 'en'), '13 GB');
  assert.strictEqual(formatBytes(1500000, 'fr'), '1,5 Mo');
});

// ── Destinations « dossier » (sans Nextcloud) ─────────────────────────────────
test('listFolderDestinations : sous-dossiers visibles de la racine', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { listFolderDestinations } = require('../server/services/targetService');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-dest-'));
  fs.mkdirSync(path.join(root, 'Archives'));
  fs.mkdirSync(path.join(root, 'Clients'));
  fs.mkdirSync(path.join(root, '.cache'));
  fs.writeFileSync(path.join(root, 'notes.txt'), 'x');
  assert.deepStrictEqual(listFolderDestinations(root).map(f => f.id), ['Archives', 'Clients']);
  assert.deepStrictEqual(listFolderDestinations(path.join(root, 'absent')), []);
});

test('destination « dossier » : validation et aucune indexation', () => {
  const { validateTargetSpec } = require('../server/lib/targetPath');
  assert.deepStrictEqual(validateTargetSpec({ type: 'folder', id: 'Archives', subPath: '2024' }), { type: 'folder', id: 'Archives', subPath: '2024' });
  assert.throws(() => validateTargetSpec({ type: 'folder', id: '../etc' }), Error);
  assert.strictEqual(scanArgs({ type: 'folder', id: 'Archives' }, 'A'), null);
});
