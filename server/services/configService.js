const fs = require('fs');
const path = require('path');
const { validateTargetSpec, parseLegacyTarget } = require('../lib/targetPath');
const { t } = require('../lib/i18n');

// Réglages persistants (data/config.json), modifiables depuis les Paramètres.
// Les variables d'environnement donnent les valeurs par défaut.

const CONFIG_FILE = path.join(process.cwd(), 'data', 'config.json');

// Fichiers système macOS / Windows qui n'ont rien à faire dans Nextcloud.
// « Icon\r » : l'icône personnalisée d'un dossier Mac (nom terminé par un retour chariot).
const DEFAULT_EXCLUDES = [
  '.DS_Store', '._*', 'Icon\r', '.Spotlight-V100', '.Trashes', '.fseventsd',
  '.TemporaryItems', '.DocumentRevisions-V100', '.apdisk', '.VolumeIcon.icns',
  'Thumbs.db', 'desktop.ini', '$RECYCLE.BIN', 'System Volume Information',
];

function defaults() {
  return {
    // Destination par défaut (proposée à l'étape 2) ; null = à choisir
    target: parseLegacyTarget(process.env.TARGET_FOLDER) || null,
    dirMode: process.env.TB_DIR_MODE || '770',
    fileMode: process.env.TB_FILE_MODE || '660',
    bwlimit: Number(process.env.TB_BWLIMIT) || 0,          // Ko/s, 0 = illimité
    excludes: DEFAULT_EXCLUDES,
    webhookUrl: process.env.TB_WEBHOOK_URL || '',
    checkSpace: process.env.TB_CHECK_SPACE !== '0',
  };
}

let settings = defaults();

function validate(input, base) {
  const out = { ...base };
  if ('target' in input) out.target = input.target ? validateTargetSpec(input.target) : null;
  for (const k of ['dirMode', 'fileMode']) {
    if (k in input) {
      const v = String(input[k]).trim();
      if (!/^[0-7]{3}$/.test(v)) throw new Error(t('err.modeInvalid', { value: v }));
      out[k] = v;
    }
  }
  if ('bwlimit' in input) {
    const v = Number(input.bwlimit);
    if (!Number.isInteger(v) || v < 0) throw new Error(t('err.bwlimitInvalid'));
    out.bwlimit = v;
  }
  if ('excludes' in input) {
    const list = Array.isArray(input.excludes) ? input.excludes : String(input.excludes).split('\n');
    // « \r » saisi littéralement (ex. « Icon\r ») devient un vrai retour chariot ;
    // on retire seulement les espaces et tabulations autour.
    out.excludes = list
      .map(s => String(s).replace(/\\r/g, '\r').replace(/^[ \t]+|[ \t]+$/g, ''))
      .filter(Boolean);
    if (out.excludes.some(s => s.includes('\n') || s.includes('\0'))) throw new Error(t('err.excludesInvalid'));
  }
  if ('webhookUrl' in input) {
    const v = String(input.webhookUrl || '').trim();
    if (v && !/^https?:\/\/[^\s]+$/i.test(v)) throw new Error(t('err.webhookInvalid'));
    out.webhookUrl = v;
  }
  if ('checkSpace' in input) out.checkSpace = Boolean(input.checkSpace);
  return out;
}

function load() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    // Migration v2 : « targetFolder » (chemin) → destination { type, id, subPath }
    if (parsed.targetFolder && !parsed.target) {
      parsed.target = parseLegacyTarget(parsed.targetFolder);
      delete parsed.targetFolder;
    }
    settings = validate(parsed, defaults());
  } catch (err) {
    console.error('Configuration ignorée :', err.message);
  }
}

function save(newSettings) {
  settings = validate(newSettings || {}, settings);
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(settings, null, 2));
  return settings;
}

function get() { return settings; }

/** Pour l'interface : les « \r » des exclusions sont affichés littéralement. */
function publicView() {
  return { ...settings, excludes: settings.excludes.map(s => s.replace(/\r/g, '\\r')) };
}

load();

module.exports = { get, save, publicView, DEFAULT_EXCLUDES };
