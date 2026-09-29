const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

// ── Persistance (uniquement /app/data) ──────────────────────────────────────
const DATA_DIR     = path.join(process.cwd(), 'data');
const QUEUE_FILE   = path.join(DATA_DIR, 'transback_queue.json');
const HISTORY_FILE = path.join(DATA_DIR, 'transback_history.json');
const { t } = require('../lib/i18n');

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}

let queue   = [];
let history = [];
let onStateChangeCallback = null;

function readJsonArray(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : null;
  } catch (_) { return null; }
}

function loadQueue() {
  queue = readJsonArray(QUEUE_FILE) || [];
  queue.forEach(task => {
    if (['transferring', 'permissions', 'indexing'].includes(task.status)) {
      task.status = 'paused';
      (task.logs = task.logs || []).push(t('task.interruptedByRestart'));
    }
  });
  saveQueue();
}

function loadHistory() {
  history = readJsonArray(HISTORY_FILE) || [];
  console.log(`History: ${history.length} task(s)`);
  saveHistory();
}

// Écriture atomique : un arrêt brutal ne laisse jamais un fichier JSON tronqué.
function writeAtomic(file, content) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function saveQueue() {
  clearTimeout(saveQueueTimer);
  saveQueueTimer = null;
  try {
    const toSave = queue.map(t => ({ ...t, logs: (t.logs || []).slice(-300) }));
    writeAtomic(QUEUE_FILE, JSON.stringify(toSave, null, 2));
  } catch (err) {
    console.error("Erreur sauvegarde file d'attente:", err.message);
  }
}

// Les journaux arrivent par centaines : on regroupe les écritures.
let saveQueueTimer = null;
function saveQueueSoon() {
  if (!saveQueueTimer) saveQueueTimer = setTimeout(saveQueue, 2000);
}

function saveHistory() {
  try {
    writeAtomic(HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (err) {
    console.error("Erreur sauvegarde historique:", err.message);
  }
}

// ── Notifications ─────────────────────────────────────────────────────────────
function setOnStateChange(cb) {
  onStateChangeCallback = cb;
}

function notifyStateChange() {
  if (onStateChangeCallback) {
    onStateChangeCallback({ queue: getQueueState(), history: getHistory() });
  }
}

// ── Lecture ───────────────────────────────────────────────────────────────────
function getQueueState() { return queue; }
function getHistory()    { return history; }

function getActiveTask() {
  return queue.find(t => ['transferring', 'permissions', 'indexing', 'paused'].includes(t.status));
}

function getTask(id) {
  return queue.find(t => t.id === id) || history.find(t => t.id === id);
}

function getQueueTask(id) {
  return queue.find(t => t.id === id);
}

/** Message d'erreur si une tâche en file (active, en pause ou à venir) lit l'un de ces volumes. */
function volumesBusyReason(volumeIds) {
  const ids = new Set(volumeIds);
  const task = queue.find(t => (t.sources || []).some(s => ids.has(s.volumeId)));
  if (!task) return null;
  const key = task.status === 'queued' ? 'eject.busyQueued' : (task.status === 'paused' ? 'eject.busyPaused' : 'eject.busyRunning');
  return t(key);
}

// ── Résumé automatique ────────────────────────────────────────────────────────
function buildSummary(task) {
  const errorLines   = (task.logs || []).filter(l => l.includes('❌'));
  const warningLines = (task.logs || []).filter(l => l.includes('⚠️'));
  const successLines = (task.logs || []).filter(l => l.includes('✅') || l.includes('✓') || l.includes('🎉'));

  let duration = null;
  if (task.startedAt && task.finishedAt) {
    const ms   = new Date(task.finishedAt) - new Date(task.startedAt);
    const secs = Math.floor(ms / 1000);
    const mins = Math.floor(secs / 60);
    const s    = secs % 60;
    duration   = mins > 0 ? `${mins}m ${s}s` : `${s}s`;
  }

  return {
    duration,
    folderCount:  (task.sourceFolders || []).length,
    errorCount:   errorLines.length,
    warningCount: warningLines.length,
    successCount: successLines.length,
    errorLines,
    warningLines,
  };
}

// ── Archivage (queue → history) ───────────────────────────────────────────────
function archiveTask(id) {
  const idx = queue.findIndex(t => t.id === id);
  if (idx === -1) return;
  const task = queue[idx];

  const archived = { ...task, summary: buildSummary(task) };
  history.unshift(archived);

  queue.splice(idx, 1);
  saveQueue();
  saveHistory();
  notifyStateChange();
}

// ── Apposition de logs et mises à jour sur une tâche (Historique ou Queue) ───
function pushHistoryLog(id, line) {
  const task = getTask(id);
  if (task) {
    if (!task.logs) task.logs = [];
    task.logs.push(line);
    if (task.logs.length > 3000) task.logs.shift();
    task.summary = buildSummary(task);
    saveHistory();
    saveQueue();
    if (onStateChangeCallback) {
      onStateChangeCallback(null, { type: 'log', taskId: id, line });
      notifyStateChange();
    }
  }
}

function updateTaskInHistory(id, updates) {
  const task = getTask(id);
  if (task) {
    Object.assign(task, updates);
    task.summary = buildSummary(task);
    saveHistory();
    saveQueue();
    notifyStateChange();
  }
}

// ── Mutations ─────────────────────────────────────────────────────────────────
/**
 * sources : [{ volumeId, volumeLabel, fsType, path, destName }]
 * target  : { type, id, subPath, label } (destination Nextcloud, figée à la création)
 * sourceFolders (affichage) : ["Étiquette/chemin", …]
 */
function addTask(sources, target, parentFolder) {
  const task = {
    id: randomUUID(),
    sources,
    sourceFolders: sources.map(s => s.path ? `${s.volumeLabel}/${s.path}` : s.volumeLabel),
    target,
    parentFolder,
    macForks: [],
    status: 'queued',
    progress: 0,
    speed: '',
    folderLabel: '',
    currentFile: '',
    transferTree: [],
    logs: [],
    error: null,
    scanResult: null,
    createdAt:  new Date().toISOString(),
    startedAt:  null,
    finishedAt: null,
  };
  queue.push(task);
  saveQueue();
  notifyStateChange();
  triggerNextTask();
  return task.id;
}

function removeTask(id) {
  const index = queue.findIndex(t => t.id === id);
  if (index !== -1) {
    const task = queue[index];
    if (['transferring', 'permissions', 'indexing'].includes(task.status)) {
      throw new Error(t('err.removeRunning'));
    }
    queue.splice(index, 1);
    saveQueue();
    notifyStateChange();
  }
}

function removeHistory(id) {
  const index = history.findIndex(t => t.id === id);
  if (index !== -1) {
    history.splice(index, 1);
    saveHistory();
    notifyStateChange();
  }
}

function reorderTask(id, direction) {
  const index = queue.findIndex(t => t.id === id);
  if (index === -1) return;
  const task = queue[index];
  if (task.status !== 'queued') return;

  if (direction === 'up' && index > 0 && queue[index - 1].status === 'queued') {
    [queue[index - 1], queue[index]] = [queue[index], queue[index - 1]];
  } else if (direction === 'down' && index < queue.length - 1 && queue[index + 1].status === 'queued') {
    [queue[index + 1], queue[index]] = [queue[index], queue[index + 1]];
  }
  saveQueue();
  notifyStateChange();
}

function updateTask(id, updates) {
  const task = getQueueTask(id);
  if (task) {
    Object.assign(task, updates);
    saveQueue();
    notifyStateChange();
  }
}

function pushLog(id, line) {
  const task = getQueueTask(id) || getTask(id);
  if (task) {
    if (!task.logs) task.logs = [];
    task.logs.push(line);
    if (task.logs.length > 2000) task.logs.shift();
    if (getQueueTask(id)) saveQueueSoon();
    if (onStateChangeCallback) onStateChangeCallback(null, { type: 'log', taskId: id, line });
  }
}

let _lastSavedProgress = {};
function updateTaskProgress(id, progress, speed) {
  const task = getQueueTask(id);
  if (task) {
    task.progress = progress;
    task.speed    = speed;
    task.status   = 'transferring';
    if (!_lastSavedProgress[id] || Math.abs(progress - _lastSavedProgress[id]) >= 2) {
      _lastSavedProgress[id] = progress;
      saveQueue();
    }
    if (onStateChangeCallback) {
      onStateChangeCallback(null, { type: 'progress', taskId: id, progress, speed });
    }
  }
}

let _lastFileNotification = 0;
function updateTaskFile(id, currentFile) {
  const task = getQueueTask(id);
  if (task) {
    task.currentFile = currentFile;
    const now = Date.now();
    if (now - _lastFileNotification >= 100) {
      _lastFileNotification = now;
      if (onStateChangeCallback) {
        onStateChangeCallback(null, { type: 'file', taskId: id, currentFile });
      }
    }
  }
}

// ── Orchestration ─────────────────────────────────────────────────────────────
let taskRunner = null;
function setTaskRunner(runner) {
  taskRunner = runner;
  triggerNextTask();
}

// Une seule tâche à la fois, y compris pendant une annulation (statut déjà « error »
// mais rsync pas encore terminé).
let runnerBusy = false;
function triggerNextTask() {
  if (runnerBusy || getActiveTask()) return;
  const nextTask = queue.find(t => t.status === 'queued');
  if (nextTask && taskRunner) {
    runnerBusy = true;
    taskRunner(nextTask.id).catch(err => {
      console.error('Task failed:', err);
    }).finally(() => {
      runnerBusy = false;
      triggerNextTask();
    });
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
loadHistory();
loadQueue();

module.exports = {
  getQueueState,
  getHistory,
  getTask,
  getQueueTask,
  getActiveTask,
  volumesBusyReason,
  addTask,
  removeTask,
  removeHistory,
  reorderTask,
  updateTask,
  pushHistoryLog,
  updateTaskInHistory,
  archiveTask,
  updateTaskProgress,
  updateTaskFile,
  pushLog,
  setOnStateChange,
  setTaskRunner,
  triggerNextTask,
};
