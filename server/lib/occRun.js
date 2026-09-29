const platform = require('../services/platformService');
const { t } = require('./i18n');

/**
 * Lance une commande occ et relaie sa sortie ligne par ligne.
 * Résout avec la sortie complète ; certaines commandes de scan finissent en code 1
 * tout en affichant leur tableau de résultats : on les considère réussies.
 */
async function runOcc(args, { log = () => {}, setProc, onLine } = {}) {
  log(`   ▶ occ ${args.join(' ')}`);
  const proc = await platform.occSpawn(args);
  if (setProc) setProc(proc);
  return new Promise((resolve, reject) => {
    let output = '';
    const relay = prefix => d => {
      const str = d.toString();
      output += str;
      if (output.length > 4e6) output = output.slice(-1e6);
      str.split('\n').filter(Boolean).forEach(l => {
        log(`${prefix}${l}`);
        if (onLine) onLine(l);
      });
    };
    proc.stdout.on('data', relay('     '));
    proc.stderr.on('data', relay('   ⚠️  '));
    proc.on('close', code => {
      if (code === 0 || (code === 1 && output.includes('|'))) return resolve(output);
      const lastErr = output.split('\n').filter(Boolean).slice(-3).join(' ') || `code ${code}`;
      reject(new Error(t('err.occFailed', { error: lastErr })));
    });
    proc.on('error', reject);
  });
}

/**
 * Tableau final de occ (groupfolders:scan ou files:scan) → { dirs, files }.
 * Les colonnes sont repérées par l'en-tête (« Folders », « Files »), car leur
 * position diffère selon la commande.
 */
function parseOccCounts(output) {
  let idxDirs = -1;
  let idxFiles = -1;
  let found = false;
  const acc = { dirs: 0, files: 0 };
  for (const line of String(output).split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    const di = cells.indexOf('Folders');
    const fi = cells.indexOf('Files');
    if (di !== -1 && fi !== -1) { idxDirs = di; idxFiles = fi; continue; }
    if (idxDirs === -1) continue;
    const d = Number(cells[idxDirs]);
    const f = Number(cells[idxFiles]);
    if (Number.isFinite(d) && Number.isFinite(f) && cells[idxDirs] !== '' && cells[idxFiles] !== '') {
      acc.dirs += d; acc.files += f; found = true;
    }
  }
  return found ? acc : null;
}

module.exports = { runOcc, parseOccCounts };
