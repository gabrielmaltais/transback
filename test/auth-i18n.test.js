const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseCookies, safeEqual } = require('../server/services/authService');
const { t, DICTS } = require('../server/lib/i18n');

test('parseCookies / safeEqual', () => {
  assert.deepStrictEqual(parseCookies('a=1; tb_session=abc%20d'), { a: '1', tb_session: 'abc d' });
  assert.strictEqual(safeEqual('secret', 'secret'), true);
  assert.strictEqual(safeEqual('secret', 'secreT'), false);
  assert.strictEqual(safeEqual('', 'x'), false);
});

test('middleware : refuse l\'API sans session quand un mot de passe est défini', () => {
  // Chargé dans un environnement isolé pour que TB_PASSWORD soit pris en compte
  const modPath = require.resolve('../server/services/authService');
  delete require.cache[modPath];
  process.env.TB_PASSWORD = 'pw';
  const auth = require(modPath);
  delete process.env.TB_PASSWORD;
  delete require.cache[modPath];

  const run = (p, headers = {}) => {
    let status = 200;
    let nextCalled = false;
    const res = { status(s) { status = s; return this; }, json() { return this; } };
    auth.middleware({ path: p, headers }, res, () => { nextCalled = true; });
    return nextCalled ? 'next' : status;
  };
  assert.strictEqual(run('/api/disks'), 401);
  assert.strictEqual(run('/api/auth/login'), 'next');
  assert.strictEqual(run('/index.html'), 'next');
  assert.strictEqual(run('/api/disks', { cookie: 'tb_session=faux' }), 401);
});

test('i18n : remplacement des variables et repli sur l\'anglais', () => {
  assert.strictEqual(t('task.start', { count: 2 }, 'en'), '🚀 Starting — 2 folder(s) to transfer');
  assert.strictEqual(t('task.start', { count: 2 }, 'fr'), '🚀 Démarrage — 2 dossier(s) à transférer');
  assert.strictEqual(t('cle.inexistante'), 'cle.inexistante');
});

test('i18n serveur : mêmes clés en anglais et en français', () => {
  assert.deepStrictEqual(Object.keys(DICTS.fr).sort(), Object.keys(DICTS.en).sort());
});

test('i18n serveur : toute clé utilisée dans le code existe', () => {
  const used = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.js')) {
        for (const m of fs.readFileSync(p, 'utf8').matchAll(/\b(?:t|msg)\(['`]([a-zA-Z0-9_.]+)['`]/g)) used.add(m[1]);
      }
    }
  };
  walk(path.join(__dirname, '..', 'server'));
  // Clés construites dynamiquement
  for (const k of ['eject.busyQueued', 'eject.busyPaused', 'eject.busyRunning', 'notify.done', 'notify.partial',
    'notify.error', 'task.partial23', 'task.partial24']) used.add(k);
  const missing = [...used].filter(k => !(k in DICTS.en));
  assert.deepStrictEqual(missing, []);
});

test('i18n interface : mêmes clés en anglais et en français', () => {
  const dir = path.join(__dirname, '..', 'public', 'i18n');
  const en = JSON.parse(fs.readFileSync(path.join(dir, 'en.json'), 'utf8'));
  const fr = JSON.parse(fs.readFileSync(path.join(dir, 'fr.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(fr).sort(), Object.keys(en).sort());
});

test('i18n interface : toute clé utilisée existe', () => {
  const pub = path.join(__dirname, '..', 'public');
  const en = JSON.parse(fs.readFileSync(path.join(pub, 'i18n', 'en.json'), 'utf8'));
  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(pub, 'app.js'), 'utf8');
  const used = new Set([
    ...[...html.matchAll(/data-i18n(?:-placeholder|-title|-aria)?="([^"]+)"/g)].map(m => m[1]),
    ...[...js.matchAll(/\bt\(\s*['`]([a-zA-Z0-9_.]+)['`]/g)].map(m => m[1]),
    // Clés dans des ternaires : t(cond ? 'a' : 'b')
    ...[...js.matchAll(/\?\s*'([a-z]+\.[a-zA-Z0-9_.]+)'\s*:\s*'([a-z]+\.[a-zA-Z0-9_.]+)'/g)].flatMap(m => [m[1], m[2]]),
    'app.title',
  ]);
  // Clés construites dynamiquement
  for (const s of ['idle', 'queued', 'transferring', 'permissions', 'indexing', 'paused', 'done', 'partial_success', 'error']) used.add(`status.${s}`);
  for (const s of ['queued', 'transferring', 'permissions', 'indexing', 'paused', 'error']) used.add(`queueStatus.${s}`);
  for (const s of ['success', 'warning', 'error']) { used.add(`result.title.${s}`); used.add(`result.subtitle.${s}`); }
  for (const s of ['done', 'partial', 'error']) used.add(`source.history.${s}`);
  const missing = [...used].filter(k => !(k in en));
  assert.deepStrictEqual(missing, []);
});
