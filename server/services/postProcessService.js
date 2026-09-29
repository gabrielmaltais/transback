const path = require('path');
const { normalizeTree } = require('../lib/normalize');
const { runOcc, parseOccCounts } = require('../lib/occRun');
const { scanArgs } = require('./targetService');
const { t } = require('../lib/i18n');

/**
 * Après la copie : noms en NFC (avec fusion des doublons NFC/NFD), puis indexation
 * Nextcloud ciblée. Les droits sont déjà appliqués par rsync.
 *   target    : destination résolue (targetService.resolve)
 *   destNames : noms (NFC) des dossiers créés sous la destination
 */
async function executePostProcess(log, setState, setProc, target, destNames = [], parentFolder = '') {
  const basePath = path.join(target.root, parentFolder);

  // ── Étape 1 : Normalisation NFD → NFC ─────────────────────────────────────
  log(t('post.normalizeStart'));
  setState({ status: 'permissions', currentFile: t('post.normalizing') });
  const stats = { renamed: 0, merged: 0 };
  for (const name of destNames) {
    await normalizeTree(path.join(basePath, name), log, stats);
  }
  log(t('post.normalizeDone', { renamed: stats.renamed, merged: stats.merged }));
  log('');

  // ── Étape 2 : indexation Nextcloud (sauf destination « dossier » sans Nextcloud) ──
  if (!target.indexed) {
    log(t('post.indexSkipped'));
    setState({ scanResult: { skipped: true, success: true }, currentFile: t('post.indexSkipped') });
    return;
  }
  const relBase = path.relative(target.filesRoot, basePath).split(path.sep).filter(Boolean).join('/');
  const paths = [...new Set(destNames.map(n => relBase ? `${relBase}/${n}` : n))];

  log(t('post.indexStart'));
  setState({ status: 'indexing', currentFile: t('post.indexPreparing') });

  let seen = 0;
  let encodingWarn = 0;
  let lastUpdate = 0;
  const onLine = (line) => {
    if (line.includes('will not be accessible due to incompatible encoding')) encodingWarn++;
    else seen++;
    const now = Date.now();
    if (now - lastUpdate >= 500) {
      lastUpdate = now;
      setState({ currentFile: t('post.indexProgress', { count: seen, warn: encodingWarn }) });
    }
  };

  try {
    let totals = { dirs: 0, files: 0 };
    let targetedOk = paths.length > 0;
    for (let i = 0; targetedOk && i < paths.length; i++) {
      setState({ status: 'indexing', currentFile: t('post.indexItem', { i: i + 1, n: paths.length, path: paths[i] }) });
      try {
        const counts = parseOccCounts(await runOcc(scanArgs(target, paths[i]), { log, setProc, onLine }));
        if (counts) { totals.dirs += counts.dirs; totals.files += counts.files; }
      } catch (err) {
        log(t('post.indexTargetedFailed', { path: paths[i], error: err.message }));
        targetedOk = false;
      }
    }
    if (!targetedOk) {
      log(t('post.indexFull', { label: target.label }));
      setState({ status: 'indexing', currentFile: t('post.indexFull', { label: target.label }) });
      totals = parseOccCounts(await runOcc(scanArgs(target, ''), { log, setProc, onLine })) || totals;
    }

    const warnMsg = encodingWarn ? t('post.encodingWarn', { count: encodingWarn }) : '';
    setState({
      scanResult: { folders: totals.dirs, files: totals.files, success: true, encodingWarnings: encodingWarn },
      currentFile: t('post.indexDone', { files: totals.files, dirs: totals.dirs, warn: warnMsg }),
    });
    log('   ' + t('post.indexDone', { files: totals.files, dirs: totals.dirs, warn: warnMsg }));
  } catch (scanErr) {
    log(t('post.indexFailed', { error: scanErr.message }));
    setState({
      scanResult: { folders: 0, files: 0, success: false, error: scanErr.message },
      currentFile: t('post.indexFailed', { error: scanErr.message }),
    });
    throw new Error(t('post.indexFailed', { error: scanErr.message }));
  }
}

module.exports = { executePostProcess };
