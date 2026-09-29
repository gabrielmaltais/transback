const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeTree } = require('../server/lib/normalize');

const NFD = s => s.normalize('NFD');
const NFC = s => s.normalize('NFC');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tb-nfc-'));
}

function names(dir) {
  return fs.readdirSync(dir).sort();
}

function setMtime(p, secondsAgo) {
  const t = new Date(Date.now() - secondsAgo * 1000);
  fs.utimesSync(p, t, t);
}

test('renomme récursivement les noms NFD en NFC', async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, NFD('Création'), NFD('Spécimen')), { recursive: true });
  fs.writeFileSync(path.join(root, NFD('Création'), NFD('Spécimen'), NFD('chèque.pdf')), 'x');

  const stats = await normalizeTree(root);

  assert.deepStrictEqual(names(root), [NFC('Création')]);
  assert.deepStrictEqual(names(path.join(root, NFC('Création'), NFC('Spécimen'))), [NFC('chèque.pdf')]);
  assert.strictEqual(stats.renamed, 3);
  assert.strictEqual(stats.merged, 0);
});

test('fusionne un dossier NFD dans son jumeau NFC (relance d\'un transfert)', async () => {
  const root = tmp();
  const nfcDir = path.join(root, NFC('Été'));
  const nfdDir = path.join(root, NFD('Été'));
  fs.mkdirSync(nfcDir);
  fs.mkdirSync(nfdDir);
  if (names(root).length !== 2) return; // système de fichiers qui confond NFC/NFD (macOS)

  fs.writeFileSync(path.join(nfcDir, 'ancien.txt'), 'ancien');
  fs.writeFileSync(path.join(nfcDir, 'commun.txt'), 'vieux');
  setMtime(path.join(nfcDir, 'commun.txt'), 3600);
  fs.writeFileSync(path.join(nfdDir, 'nouveau.txt'), 'nouveau');
  fs.writeFileSync(path.join(nfdDir, 'commun.txt'), 'récent');

  const stats = await normalizeTree(root);

  assert.deepStrictEqual(names(root), [NFC('Été')]);
  assert.deepStrictEqual(names(nfcDir), ['ancien.txt', 'commun.txt', 'nouveau.txt']);
  assert.strictEqual(fs.readFileSync(path.join(nfcDir, 'commun.txt'), 'utf8'), 'récent');
  assert.ok(stats.merged >= 1);
});

test('doublon de fichier : garde la version la plus récente', async () => {
  const root = tmp();
  const nfc = path.join(root, NFC('reçu.pdf'));
  const nfd = path.join(root, NFD('reçu.pdf'));
  fs.writeFileSync(nfc, 'récent');
  fs.writeFileSync(nfd, 'ancien');
  if (names(root).length !== 2) return;
  setMtime(nfd, 3600);

  await normalizeTree(root);

  assert.deepStrictEqual(names(root), [NFC('reçu.pdf')]);
  assert.strictEqual(fs.readFileSync(nfc, 'utf8'), 'récent');
});

test('conflit fichier / dossier : renomme sans rien perdre', async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, NFC('Été')));
  fs.writeFileSync(path.join(root, NFD('Été')), 'fichier');
  if (names(root).length !== 2) return;

  await normalizeTree(root);

  assert.deepStrictEqual(names(root), [NFC('Été'), NFC('Été (2)')]);
});
