const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

// Traductions des messages du serveur (journaux, erreurs, diagnostic).
// Langue par défaut : TB_LANG (« en » si absent). Pendant une requête HTTP, la langue
// de l'interface (en-tête X-TB-Lang, sinon Accept-Language) est utilisée à la place.

const DICTS = {
  en: require(path.join(__dirname, '..', 'i18n', 'en.json')),
  fr: require(path.join(__dirname, '..', 'i18n', 'fr.json')),
};

function normalizeLang(l) {
  const code = String(l || '').slice(0, 2).toLowerCase();
  return DICTS[code] ? code : null;
}

const LANG = normalizeLang(process.env.TB_LANG) || 'en';
const store = new AsyncLocalStorage();

function currentLang() {
  const s = store.getStore();
  return (s && s.lang) || LANG;
}

function t(key, vars = {}, lang = currentLang()) {
  const s = (DICTS[lang] && DICTS[lang][key]) ?? DICTS.en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : `{${k}}`));
}

/** Middleware Express : la suite de la requête utilise la langue de l'interface. */
function middleware(req, res, next) {
  const lang = normalizeLang(req.headers['x-tb-lang']) || normalizeLang(req.headers['accept-language']) || LANG;
  store.run({ lang }, next);
}

module.exports = { t, LANG, DICTS, normalizeLang, currentLang, middleware };
