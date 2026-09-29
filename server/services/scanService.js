const configService = require('./configService');
const targetService = require('./targetService');
const { runOcc, parseOccCounts } = require('../lib/occRun');
const { t } = require('../lib/i18n');

// Indexation complète (maintenance) de la destination par défaut, ou d'une destination donnée.

let currentProc = null;
let scanJob = idleJob();
let onScanStateChangeCallback = null;

function idleJob() {
  return {
    status: 'idle', mode: null, progressMessage: '', filesCount: 0, dirsCount: 0,
    encodingWarnings: 0, logs: [], startedAt: null, finishedAt: null, error: null,
  };
}

function setOnScanStateChange(cb) { onScanStateChangeCallback = cb; }
function notifyStateChange() { if (onScanStateChangeCallback) onScanStateChangeCallback(getScanStatus()); }
function getScanStatus() { return scanJob; }

function pushScanLog(line) {
  scanJob.logs.push(line);
  if (scanJob.logs.length > 1000) scanJob.logs.shift();
  notifyStateChange();
}

async function startGlobalScanJob(targetSpec) {
  if (scanJob.status === 'running') throw new Error(t('scan.alreadyRunning'));
  const spec = targetSpec || configService.get().target;
  if (!spec) throw new Error(t('err.targetMissing'));
  const target = await targetService.resolve(spec);
  if (!target.indexed) throw new Error(t('scan.notNextcloud'));

  scanJob = { ...idleJob(), status: 'running', mode: 'global', progressMessage: t('scan.starting', { label: target.label }), startedAt: new Date().toISOString() };
  notifyStateChange();

  let seen = 0;
  let encodingWarn = 0;
  let last = 0;
  const onLine = (line) => {
    if (line.includes('will not be accessible due to incompatible encoding')) encodingWarn++; else seen++;
    if (Date.now() - last > 500) {
      last = Date.now();
      scanJob.progressMessage = t('post.indexProgress', { count: seen, warn: encodingWarn });
      notifyStateChange();
    }
  };

  try {
    const output = await runOcc(targetService.scanArgs(target, ''), { log: pushScanLog, setProc: p => { currentProc = p; }, onLine });
    const counts = parseOccCounts(output) || { dirs: 0, files: 0 };
    Object.assign(scanJob, {
      status: 'done', finishedAt: new Date().toISOString(), filesCount: counts.files, dirsCount: counts.dirs,
      encodingWarnings: encodingWarn, progressMessage: t('scan.done', { files: counts.files, dirs: counts.dirs }),
    });
  } catch (err) {
    if (scanJob.status === 'running') {
      Object.assign(scanJob, { status: 'error', finishedAt: new Date().toISOString(), error: err.message, progressMessage: err.message });
    }
  } finally {
    currentProc = null;
    notifyStateChange();
  }
}

function cancelScanJob() {
  if (scanJob.status === 'running' && currentProc) {
    try { currentProc.kill('SIGTERM'); } catch (_) {}
    Object.assign(scanJob, { status: 'error', error: t('scan.cancelled'), finishedAt: new Date().toISOString() });
    notifyStateChange();
  }
}

module.exports = { startGlobalScanJob, cancelScanJob, getScanStatus, setOnScanStateChange };
