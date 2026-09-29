'use strict';

// Traductions de l'interface : public/i18n/<langue>.json
//   data-i18n="clé"             → textContent
//   data-i18n-placeholder="clé" → placeholder
//   data-i18n-title="clé"       → title
//   data-i18n-aria="clé"        → aria-label
// Langue : choix mémorisé, sinon langue du navigateur (fr/en), sinon anglais.

window.I18N = (() => {
  const SUPPORTED = ['en', 'fr'];
  let lang = 'en';
  let dict = {};
  let fallback = {};

  function detectLang() {
    try {
      const saved = localStorage.getItem('tb.lang');
      if (SUPPORTED.includes(saved)) return saved;
    } catch (_) {}
    const nav = (navigator.language || 'en').slice(0, 2).toLowerCase();
    return SUPPORTED.includes(nav) ? nav : 'en';
  }

  async function load(code) {
    const res = await fetch(`i18n/${code}.json`, { cache: 'no-store' });
    return res.json();
  }

  function t(key, vars = {}) {
    const s = dict[key] ?? fallback[key] ?? key;
    return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : `{${k}}`));
  }

  function apply(root = document) {
    root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
    root.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.dataset.i18nPlaceholder); });
    root.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
    root.querySelectorAll('[data-i18n-aria]').forEach(el => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
    document.documentElement.lang = lang;
    document.title = t('app.title');
  }

  async function setLang(code) {
    lang = SUPPORTED.includes(code) ? code : 'en';
    try { localStorage.setItem('tb.lang', lang); } catch (_) {}
    [fallback, dict] = await Promise.all([load('en'), lang === 'en' ? Promise.resolve(null) : load(lang)]);
    if (!dict) dict = fallback;
    apply();
  }

  const ready = (async () => {
    lang = detectLang();
    await setLang(lang);
  })();

  return {
    t, apply, setLang, ready,
    get lang() { return lang; },
    // Formats de dates et de nombres selon la langue
    get locale() { return lang === 'fr' ? 'fr-CA' : 'en-US'; },
  };
})();

const t = (key, vars) => window.I18N.t(key, vars);
