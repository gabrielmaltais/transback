const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { executePostProcess } = require('./postProcessService');
const { updateHistory, historyKey } = require('./historyService');
const queueService = require('./queueService');
const configService = require('./configService');
const diskService = require('./diskService');
const targetService = require('./targetService');
const { resolveSafe } = require('../lib/safePath');
const { detectResourceForks, MAX_REPORTED } = require('../lib/macForks');
const { formatBytes, parseRsyncTransferSize } = require('../lib/format');
const { postWebhook } = require('../lib/notify');
const { t, LANG } = require('../lib/i18n');

// rsync peut rester longtemps silencieux (liste des fichiers d'un gros dossier) :
// on le considère bloqué seulement s'il n'écrit rien ET ne consomme aucun CPU.
const WATCHDOG_TIMEOUT = Number(process.env.TB_WATCHDOG_MS) || 10 * 60 * 1000;
const WATCHDOG_INTERVAL = Math.min(30 * 1000, WATCHDOG_TIMEOUT / 2);

// ── Contrôle d'exécution ───────────────────────────────────────────────────
let currentProcess = null;
let isCancelled = false;
let isPaused = false;
let currentTaskId = null;

const PROGRESS_RE = /(\d[\d,]*)\s+(\d+)%\s+([\d.]+\s*\S+\/s)/;

class Cancelled extends Error {
  constructor() { super(t('task.cancelled')); }
}

// rsync local lance plusieurs processus (émetteur, générateur, récepteur) :
// les signaux (pause, reprise, annulation) visent tout le groupe.
function signalGroup(proc, sig) {
  if (!proc) return;
  try { process.kill(-proc.pid, sig); }
  catch (_) { try { proc.kill(sig); } catch (_) {} }
}

async function cpuTicksOfGroup(pgid) {
  let total = 0;
  let entries = [];
  try { entries = await fs.promises.readdir('/proc'); } catch (_) { return -1; }
  for (const pid of entries) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const stat = await fs.promises.readFile(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[2]) === pgid) total += Number(fields[11]) + Number(fields[12]);
    } catch (_) {}
  }
  return total;
}

/** Options rsync communes (copie réelle et estimation de taille). */
function rsyncOptions(owner) {
  const s = configService.get();
  const args = [
    // Pas de -l : les liens symboliques ne sont pas copiés (risque de pointer hors du disque).
    '-rtpog', '--update',
    `--chown=${owner.uid}:${owner.gid}`, `--chmod=D${s.dirMode},F${s.fileMode}`,
    ...s.excludes.flatMap(e => ['--exclude', e]),
  ];
  if (s.bwlimit > 0) args.push(`--bwlimit=${s.bwlimit}`);
  return args;
}

// ── Estimation de la taille à copier (rsync -n --stats) ────────────────────
function measureTransfer(src, dst, owner) {
  return new Promise((resolve) => {
    const proc = spawn('rsync', ['-n', '--stats', ...rsyncOptions(owner), src, dst], { detached: true });
    currentProcess = proc;
    let out = '';
    proc.stdout.on('data', d => { out += d.toString(); if (out.length > 1e6) out = out.slice(-2e5); });
    proc.on('close', () => resolve(parseRsyncTransferSize(out)));
    proc.on('error', () => resolve(null));
  });
}

// ── Un rsync (promesse) ────────────────────────────────────────────────────
function runRsync(taskId, src, dst, owner, folderIndex, folderTotal, currentNode) {
  return new Promise((resolve, reject) => {
    const args = [...rsyncOptions(owner), '--info=progress2', '--no-inc-recursive', src, dst];
    const rsync = spawn('rsync', args, { detached: true });
    currentProcess = rsync;
    let buffer = '';
    let finished = false;
    let lastActivity = Date.now();
    let lastTicks = -1;

    const finish = (fn, value) => {
      if (finished) return;
      finished = true;
      clearInterval(watchdog);
      fn(value);
    };

    const watchdog = setInterval(async () => {
      if (finished) return;
      if (isPaused) { lastActivity = Date.now(); return; }
      const ticks = await cpuTicksOfGroup(rsync.pid);
      if (ticks !== lastTicks) { lastTicks = ticks; lastActivity = Date.now(); }
      if (Date.now() - lastActivity > WATCHDOG_TIMEOUT) {
        queueService.pushLog(taskId, t('task.watchdogLog', { minutes: WATCHDOG_TIMEOUT / 60000 }));
        signalGroup(rsync, 'SIGKILL');
        // On n'attend pas « close » : un processus bloqué sur un disque (état D) peut ne jamais se terminer.
        finish(reject, new Error(t('task.watchdogError')));
      }
    }, WATCHDOG_INTERVAL);

    rsync.stdout.on('data', data => {
      if (finished) return;
      lastActivity = Date.now();
      buffer += data.toString();
      const lines = buffer.split(/[\r\n]+/);
      buffer = lines.pop();
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        const m = line.match(PROGRESS_RE);
        if (m) {
          const globalPct = Math.floor((folderIndex * 100 + parseInt(m[2], 10)) / folderTotal);
          queueService.updateTaskProgress(taskId, globalPct, m[3]);
          continue;
        }
        queueService.updateTaskFile(taskId, line);
        queueService.pushLog(taskId, line);
        markTreeProgress(taskId, currentNode, line);
      }
    });

    rsync.stderr.on('data', data => {
      if (finished) return;
      lastActivity = Date.now();
      data.toString().split('\n').filter(Boolean).forEach(l => queueService.pushLog(taskId, `⚠️  ${l}`));
    });

    rsync.on('close', (code, signal) => {
      if (code === 0) return finish(resolve, { warning: false });
      if (code === 23 || code === 24) {
        queueService.pushLog(taskId, t(code === 24 ? 'task.partial24' : 'task.partial23'));
        return finish(resolve, { warning: true });
      }
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      finish(reject, new Error(t('task.rsyncFailed', { reason, src })));
    });

    rsync.on('error', err => finish(reject, err));
  });
}

function markTreeProgress(taskId, currentNode, line) {
  if (!currentNode || !currentNode.children.length) return;
  const topLevel = line.split('/')[0];
  const idx = currentNode.children.findIndex(c => c.name === topLevel);
  if (idx === -1 || currentNode.children[idx].status === 'transferring') return;
  for (let j = 0; j < idx; j++) currentNode.children[j].status = 'done';
  currentNode.children[idx].status = 'transferring';
  const task = queueService.getTask(taskId);
  if (task) queueService.updateTask(taskId, { transferTree: task.transferTree });
}

// ── Résolution des sources : { volumeId, volumeLabel, fsType, path, destName } ──
async function resolveSource(source) {
  if (typeof source === 'string') throw new Error(t('err.legacySource'));
  const { root } = await diskService.getVolumeRoot(source.volumeId);
  const abs = await resolveSafe(root, source.path);
  return {
    abs, fsType: source.fsType, label: `${source.volumeLabel}/${source.path}`.replace(/\/$/, ''),
    destName: source.destName, key: historyKey(source.volumeId, source.path),
  };
}

// Crée les dossiers intermédiaires avec le propriétaire et les droits de Nextcloud :
// sinon ils appartiennent à root et Nextcloud ne peut rien y renommer ni supprimer.
async function ensureNextcloudDir(root, owner, ...segments) {
  const mode = parseInt(configService.get().dirMode, 8);
  let dir = root;
  for (const seg of segments.filter(Boolean)) {
    dir = path.join(dir, seg);
    try {
      await fs.promises.mkdir(dir);
      await fs.promises.chown(dir, owner.uid, owner.gid);
      await fs.promises.chmod(dir, mode);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  return dir;
}

async function listSubfolders(dir) {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    return entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  } catch (_) { return []; }
}

async function freeSpace(dir) {
  try {
    const s = await fs.promises.statfs(dir);
    return s.bavail * s.bsize;
  } catch (_) { return null; }
}

// ── Exécution d'une tâche ─────────────────────────────────────────────────
async function executeTask(taskId) {
  const task = queueService.getTask(taskId);
  if (!task) return;

  isCancelled = false;
  isPaused = false;
  currentProcess = null;
  currentTaskId = taskId;
  let taskHasWarnings = false;
  const log = (line) => queueService.pushLog(taskId, line);
  const checkCancel = () => { if (isCancelled) throw new Cancelled(); };

  queueService.updateTask(taskId, {
    status: 'transferring', progress: task.progress || 0, speed: '', currentFile: '',
    folderLabel: '', error: null,
    startedAt: task.startedAt || new Date().toISOString()
  });

  const sources = task.sources || [];
  const parentFolder = task.parentFolder || '';
  const total = sources.length;
  const resolved = [];
  const destNames = [];
  const macForks = task.macForks || [];

  try {
    const target = await targetService.resolve(task.target);
    const owner = target.owner;

    for (const s of sources) {
      try {
        resolved.push(await resolveSource(s));
      } catch (err) {
        resolved.push({ error: err.message, label: typeof s === 'string' ? s : `${s.volumeLabel}/${s.path}`, destName: typeof s === 'string' ? path.basename(s) : s.destName });
      }
    }

    // Arborescence affichée (dossiers de 1er niveau de chaque source)
    let transferTree = task.transferTree && task.transferTree.length ? task.transferTree : null;
    if (!transferTree) {
      transferTree = [];
      for (const r of resolved) {
        const children = r.abs ? await listSubfolders(r.abs) : [];
        transferTree.push({ id: r.label, name: r.destName, status: 'pending', children: children.map(name => ({ name, status: 'pending' })) });
      }
    }
    queueService.updateTask(taskId, { transferTree });

    log(t('task.start', { count: total }));
    log(t('task.destination', { label: target.label, path: target.root }));
    if (parentFolder) log(t('task.parent', { name: parentFolder }));
    log('');

    // Dossiers de destination (créés avec le propriétaire de Nextcloud)
    const targetSegs = target.subPath ? target.subPath.split('/') : [];
    for (const r of resolved) {
      if (r.error) continue;
      r.dst = (await ensureNextcloudDir(target.filesRoot, owner, ...targetSegs, parentFolder, r.destName)) + '/';
    }

    // ── Contrôle de l'espace libre ─────────────────────────────────────────
    if (configService.get().checkSpace) {
      queueService.updateTask(taskId, { currentFile: t('task.measuring') });
      log(t('task.measuring'));
      let needed = 0;
      for (const r of resolved) {
        if (r.error) continue;
        checkCancel();
        const size = await measureTransfer(r.abs + '/', r.dst, owner);
        if (size !== null) needed += size;
      }
      checkCancel();
      const free = await freeSpace(target.filesRoot);
      log(t('task.spaceInfo', { needed: formatBytes(needed, LANG), free: free === null ? '?' : formatBytes(free, LANG) }));
      if (free !== null && needed > free * 0.98) {
        throw new Error(t('task.noSpace', { needed: formatBytes(needed, LANG), free: formatBytes(free, LANG) }));
      }
      log('');
    }

    for (let i = 0; i < total; i++) {
      checkCancel();
      const r = resolved[i];
      const currentTree = queueService.getTask(taskId).transferTree;
      const currentNode = currentTree[i];
      const label = `[${i + 1}/${total}] ${r.label}`;
      queueService.updateTask(taskId, { folderLabel: label, currentFile: '' });
      log(`📦 ${label}`);

      const setNode = (status) => {
        if (!currentNode) return;
        currentNode.status = status;
        if (status === 'done') currentNode.children.forEach(c => { if (c.status !== 'error') c.status = 'done'; });
        queueService.updateTask(taskId, { transferTree: currentTree });
      };

      if (r.error) {
        log(t('task.sourceUnavailable', { error: r.error }));
        taskHasWarnings = true;
        setNode('error');
        continue;
      }

      log(t('task.source', { path: r.abs }));
      log(t('task.target', { path: r.dst }));
      destNames.push(r.destName);
      setNode('transferring');
      updateHistory(r.key, 'partial');

      let result;
      try {
        result = await runRsync(taskId, r.abs + '/', r.dst, owner, i, total, currentNode);
      } catch (err) {
        checkCancel();
        log(t('task.folderFailed', { error: err.message }));
        taskHasWarnings = true;
        setNode('error');
        updateHistory(r.key, 'error');
        continue;
      }
      checkCancel();
      if (result.warning) taskHasWarnings = true;

      if (['hfs', 'hfsplus', 'apfs'].includes(r.fsType) && macForks.length < MAX_REPORTED) {
        queueService.updateTask(taskId, { currentFile: t('task.forksSearch') });
        const found = await detectResourceForks(r.abs, r.fsType);
        for (const f of found) {
          if (macForks.length >= MAX_REPORTED) break;
          macForks.push(`${r.destName}/${f}`);
        }
        if (found.length) {
          log(t('task.forksFound', { count: found.length }));
          queueService.updateTask(taskId, { macForks });
        }
      }

      updateHistory(r.key, result.warning ? 'partial' : 'done');
      setNode('done');
      log(t('task.folderDone') + '\n');
    }

    log(t('task.copyDone') + '\n');
    queueService.updateTask(taskId, { status: 'permissions', progress: 100, speed: '', folderLabel: '' });
    checkCancel();

    await executePostProcess(log, (upd) => queueService.updateTask(taskId, upd), (proc) => { currentProcess = proc; },
      target, destNames, parentFolder);

    if (macForks.length) {
      taskHasWarnings = true;
      log('\n' + t('task.forksSummary', { count: `${macForks.length}${macForks.length >= MAX_REPORTED ? '+' : ''}` }));
      macForks.forEach(f => log(`   ⚠️ ${f}`));
    }

    if (taskHasWarnings) {
      log('\n' + t('task.doneWarnings'));
      queueService.updateTask(taskId, { status: 'partial_success', finishedAt: new Date().toISOString() });
    } else {
      log('\n' + t(target.indexed ? 'task.doneOk' : 'task.doneOkFolder'));
      queueService.updateTask(taskId, { status: 'done', finishedAt: new Date().toISOString() });
    }
  } catch (err) {
    log(`❌ ${err.message}`);
    queueService.updateTask(taskId, { status: 'error', error: err.message, finishedAt: new Date().toISOString() });
  } finally {
    currentProcess = null;
    currentTaskId = null;
    const finished = queueService.getTask(taskId);
    queueService.archiveTask(taskId);
    notifyEnd(finished);
  }
}

function notifyEnd(task) {
  const url = configService.get().webhookUrl;
  if (!url || !task) return;
  const names = (task.sourceFolders || []).map(f => f.split('/').pop()).join(', ');
  const key = { done: 'notify.done', partial_success: 'notify.partial', error: 'notify.error' }[task.status] || 'notify.error';
  postWebhook(url, {
    event: 'transback.task.finished',
    status: task.status,
    message: t(key, { names, error: task.error || '' }),
    task: {
      id: task.id, sources: task.sourceFolders, target: task.target, parentFolder: task.parentFolder,
      startedAt: task.startedAt, finishedAt: task.finishedAt, error: task.error, macForks: (task.macForks || []).length,
    },
  }, (l) => console.warn(l));
}

queueService.setTaskRunner(executeTask);

function pauseTransfer(taskId) {
  if (currentTaskId === taskId && currentProcess && !isPaused) {
    signalGroup(currentProcess, 'SIGSTOP');
    isPaused = true;
    queueService.updateTask(currentTaskId, { status: 'paused' });
    queueService.pushLog(currentTaskId, t('task.paused'));
  }
}

function resumeTransfer(taskId) {
  if (currentTaskId === taskId && currentProcess && isPaused) {
    signalGroup(currentProcess, 'SIGCONT');
    isPaused = false;
    queueService.updateTask(currentTaskId, { status: 'transferring' });
    queueService.pushLog(currentTaskId, t('task.resumed'));
    return;
  }
  // Tâche interrompue (ex. redémarrage du serveur) : on la relance, rsync reprend là où il en était.
  const task = queueService.getQueueTask(taskId);
  if (task && ['paused', 'queued', 'error'].includes(task.status) && currentTaskId !== taskId) {
    queueService.updateTask(taskId, { status: 'queued', speed: '', currentFile: '', error: null });
    queueService.pushLog(taskId, t('task.restarting'));
    queueService.triggerNextTask();
  }
}

function cancelTransfer(taskId) {
  if (currentTaskId === taskId && !isCancelled) {
    isCancelled = true;
    queueService.pushLog(currentTaskId, t('task.cancelling'));
    queueService.updateTask(currentTaskId, { status: 'error', error: t('task.cancelled') });
    if (currentProcess) {
      if (isPaused) { signalGroup(currentProcess, 'SIGCONT'); isPaused = false; }
      signalGroup(currentProcess, 'SIGTERM');
    }
    return;
  }
  const task = queueService.getQueueTask(taskId);
  if (task && task.status === 'paused') {
    queueService.updateTask(taskId, { status: 'error', error: t('task.cancelled') });
    queueService.archiveTask(taskId);
  }
}

module.exports = { pauseTransfer, resumeTransfer, cancelTransfer };
