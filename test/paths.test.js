const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveSafe } = require('../server/lib/safePath');
const { validateParentFolder, validateSubPath, validateTargetSpec, parseLegacyTarget } = require('../server/lib/targetPath');

function tmpTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-safe-'));
  fs.mkdirSync(path.join(root, 'disque', 'Projets', 'Été 2024'), { recursive: true });
  fs.mkdirSync(path.join(root, 'ailleurs'));
  return root;
}

test('resolveSafe : chemin normal sous la racine', async () => {
  const root = tmpTree();
  const disk = path.join(root, 'disque');
  const p = await resolveSafe(disk, 'Projets/Été 2024');
  assert.strictEqual(p, fs.realpathSync(path.join(disk, 'Projets', 'Été 2024')));
  assert.strictEqual(await resolveSafe(disk, ''), fs.realpathSync(disk));
});

test('resolveSafe : refuse la remontée hors du disque', async () => {
  const root = tmpTree();
  const disk = path.join(root, 'disque');
  await assert.rejects(resolveSafe(disk, '../ailleurs'), /hors du disque/);
  await assert.rejects(resolveSafe(disk, 'Projets/../../ailleurs'), /hors du disque/);
  await assert.rejects(resolveSafe(disk, '/etc'), /hors du disque|ENOENT/);
});

test('resolveSafe : refuse un lien symbolique qui sort du disque', async (t) => {
  const root = tmpTree();
  const disk = path.join(root, 'disque');
  try {
    fs.symlinkSync(path.join(root, 'ailleurs'), path.join(disk, 'lien'), 'dir');
  } catch (err) {
    t.skip(`liens symboliques non disponibles ici (${err.code})`);
    return;
  }
  await assert.rejects(resolveSafe(disk, 'lien'), /hors du disque/);
});

test('resolveSafe : chemin inexistant', async () => {
  const root = tmpTree();
  await assert.rejects(resolveSafe(path.join(root, 'disque'), 'nexiste/pas'), /ENOENT/);
});

test('validateTargetSpec : dossier de groupe et utilisateur', () => {
  assert.deepStrictEqual(validateTargetSpec({ type: 'group', id: 3, subPath: '/Archives/2024/' }),
    { type: 'group', id: '3', subPath: 'Archives/2024' });
  assert.deepStrictEqual(validateTargetSpec({ type: 'user', id: 'alice', subPath: '' }),
    { type: 'user', id: 'alice', subPath: '' });
  for (const bad of [null, {}, { type: 'group', id: 'abc' }, { type: 'user', id: '../bob' }, { type: 'user', id: '.alice' },
    { type: 'disk', id: '1' }, { type: 'group', id: '1', subPath: 'a/../../etc' }, { type: 'group', id: '1', subPath: 'a/.hidden' }]) {
    assert.throws(() => validateTargetSpec(bad), Error, `devrait refuser ${JSON.stringify(bad)}`);
  }
});

test('validateSubPath', () => {
  assert.strictEqual(validateSubPath(' /Photos / 2024/ '), 'Photos/2024');
  assert.strictEqual(validateSubPath('Été'), 'Été');
  assert.strictEqual(validateSubPath(''), '');
  assert.throws(() => validateSubPath('a/..'), Error);
});

test('parseLegacyTarget : ancienne configuration par chemin', () => {
  assert.deepStrictEqual(parseLegacyTarget('/mnt/nextcloud_data/__groupfolders/1/files'), { type: 'group', id: '1', subPath: '' });
  assert.deepStrictEqual(parseLegacyTarget('/mnt/nextcloud_data/__groupfolders/7/files/Test'), { type: 'group', id: '7', subPath: 'Test' });
  assert.strictEqual(parseLegacyTarget('/etc'), null);
  assert.strictEqual(parseLegacyTarget(undefined), null);
});

test('validateParentFolder', () => {
  assert.strictEqual(validateParentFolder('  Archives 2025 '), 'Archives 2025');
  assert.strictEqual(validateParentFolder(''), '');
  assert.strictEqual(validateParentFolder('Été'), 'Été');
  for (const bad of ['a/b', '..', '.cache', 'a\\b']) {
    assert.throws(() => validateParentFolder(bad), Error, `devrait refuser ${bad}`);
  }
});
