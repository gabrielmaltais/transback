const fs = require('fs');
const path = require('path');

// Statut par dossier source (« done », « partial », « error »), indexé par
// « <id du volume>:<chemin relatif> ». Stocké dans /app/data, hors de Nextcloud.
// « legacy » : statuts indexés par le seul nom de dossier (anciennes versions),
// affichés comme « un dossier de ce nom a déjà été transféré ».
const HISTORY_FILE = path.join(process.cwd(), 'data', 'folder_history.json');

let cache = null;

function load() {
  if (cache) return cache;
  cache = { entries: {}, legacy: {} };
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      cache = { entries: {}, legacy: {}, ...JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) };
    }
  } catch (err) {
    console.error('folder_history.json:', err.message);
  }
  return cache;
}

function save() {
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    console.error('Écriture historique des dossiers impossible :', err.message);
  }
}

function historyKey(volumeId, relPath) {
  return `${volumeId}:${relPath}`;
}

function updateHistory(key, status) {
  load().entries[key] = { status, timestamp: new Date().toISOString() };
  save();
}

/** { status, legacy } pour un dossier, ou null. */
function lookup(volumeId, relPath) {
  const h = load();
  const exact = h.entries[historyKey(volumeId, relPath)];
  if (exact) return { status: exact.status, legacy: false };
  const name = relPath.split('/').pop();
  const old = h.legacy[name] || h.legacy[name.normalize('NFC')];
  return old ? { status: old.status, legacy: true } : null;
}

module.exports = { updateHistory, lookup, historyKey };
