'use strict';

// ── Références DOM ────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const els = {
  badge: $('status-badge'),
  badgeLabel: document.querySelector('#status-badge .badge-label'),
  diskList: $('disk-list'),
  scanHint: $('scan-hint'),
  btnRescanUsb: $('btn-rescan-usb'),
  folderSelectionArea: $('folder-selection-area'),
  breadcrumb: $('breadcrumb'),
  folderHint: $('folder-hint'),
  folderGrid: $('folder-grid'),
  btnSelectAll: $('btn-select-all'),
  btnSelectCurrent: $('btn-select-current'),
  selectionPanel: $('selection-panel'),
  selectionList: $('selection-list'),
  selectionCountLabel: $('selection-count-label'),
  btnClearSelection: $('btn-clear-selection'),
  btnStep1Next: $('btn-step1-next'),
  btnPause: $('btn-pause'),
  btnResume: $('btn-resume'),
  btnCancel: $('btn-cancel'),
  selectTarget: $('select-target'),
  targetHint: $('target-hint'),
  inputTargetSubpath: $('input-target-subpath'),
  inputSubfolder: $('input-subfolder'),
  destSummary: $('dest-summary'),
  btnStep2Back: $('btn-step2-back'),
  btnStep2Launch: $('btn-step2-launch'),
  progressPct: $('progress-pct'),
  progressSpeed: $('progress-speed'),
  progressBar: $('progress-bar'),
  progressTrack: $('progress-track'),
  progressFile: $('progress-file'),
  consoleBody: $('console-body'),
  transferTree: $('transfer-tree'),
  resultIcon: $('result-icon'),
  resultTitle: $('title-step-4'),
  resultSubtitle: $('result-subtitle'),
  resultSummary: $('result-summary'),
  btnNewTransfer: $('btn-new-transfer'),
  btnRefreshQueue: $('btn-refresh-queue'),
  btnAddTask: $('btn-add-task'),
};

// Tout texte venant d'un disque ou du serveur passe par ici avant innerHTML.
function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function api(url, options = {}) {
  // X-TB-Lang : les messages du serveur (erreurs, diagnostic) suivent la langue de l'interface
  const headers = { 'X-TB-Lang': I18N.lang, ...(options.headers || {}) };
  if (options.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) { showLogin(); throw new Error(t('login.required')); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ── État local ────────────────────────────────────────────────────────────
// Sélection : clé « volumeId:chemin » → { volumeId, volumeLabel, path, name }
const selectedSources = new Map();
let disks = [];
let currentVolume = null;   // { id, label, fsType }
let currentPath = '';
let currentFolders = [];
let currentFileCount = 0;
let targets = { groups: [], users: [], folders: [], default: null };
let evtSource = null;
let currentViewTaskId = null;
let queueData = [];
let historyData = [];

// ── Navigation entre étapes ───────────────────────────────────────────────
function goToStep(n) {
  document.querySelectorAll('.step-panel').forEach(p => { p.classList.remove('active'); p.hidden = true; });
  const panel = $(`panel-step-${n}`);
  if (panel) { panel.hidden = false; panel.classList.add('active'); }
  if (n === 0) return; // prévisualisation : ne change pas les indicateurs d'étapes
  document.querySelectorAll('.step-item').forEach(item => {
    const s = parseInt(item.dataset.step, 10);
    item.classList.remove('active', 'completed');
    if (s < n) item.classList.add('completed');
    if (s === n) item.classList.add('active');
  });
}

// ── Badge de statut ───────────────────────────────────────────────────────
function updateBadge(status) {
  els.badgeLabel.textContent = t(`status.${status}`);
  els.badge.className = 'header-badge';
  if (['transferring', 'permissions', 'indexing'].includes(status)) els.badge.classList.add('status-active');
  if (status === 'paused') els.badge.classList.add('status-paused');
  if (status === 'done') els.badge.classList.add('status-success');
  if (status === 'partial_success') els.badge.classList.add('status-warning');
  if (status === 'error') els.badge.classList.add('status-error');
}

const PHASE_ORDER = ['transferring', 'permissions', 'indexing', 'done'];
function updatePipeline(status) {
  const idx = PHASE_ORDER.indexOf(status);
  PHASE_ORDER.forEach((phase, i) => {
    const el = $(`phase-${phase}`);
    if (!el) return;
    el.classList.remove('phase-active', 'phase-done');
    if (status === 'done' || status === 'partial_success') { el.classList.add('phase-done'); return; }
    if (i < idx) el.classList.add('phase-done');
    if (i === idx) el.classList.add('phase-active');
  });
}

// ── Journal (console) ─────────────────────────────────────────────────────
function logClass(line) {
  if (line.includes('❌')) return 'log-error';
  if (line.includes('⚠️')) return 'log-warn';
  if (line.includes('✅') || line.includes('🎉') || line.includes('✓')) return 'log-success';
  if (/[🚀☁️📏▶📦]/u.test(line)) return 'log-info';
  return '';
}

function renderLogLines(lines) {
  return lines.map(l => `<span class="console-line ${logClass(l)}" data-cat="${logClass(l)}">${escHtml(l)}</span>\n`).join('');
}

let pendingLogs = [];
let logFlushScheduled = false;
function queueLog(line) {
  pendingLogs.push(line);
  if (!logFlushScheduled) {
    logFlushScheduled = true;
    requestAnimationFrame(() => {
      logFlushScheduled = false;
      batchLogs(pendingLogs.splice(0));
    });
  }
}
function clearConsole() {
  pendingLogs = [];
  els.consoleBody.innerHTML = '';
}
function batchLogs(logs) {
  if (!logs || !logs.length) return;
  els.consoleBody.insertAdjacentHTML('beforeend', renderLogLines(logs.slice(-300)));
  els.consoleBody.scrollTop = els.consoleBody.scrollHeight;
}

// ── Progression d'une tâche ───────────────────────────────────────────────
function applyTaskState(task) {
  if (!task || currentViewTaskId !== task.id) return;
  const active = ['transferring', 'permissions', 'indexing', 'paused'];
  updateBadge(task.status);
  updatePipeline(task.status);

  const actions = document.querySelector('.transfer-actions');
  if (active.includes(task.status)) {
    actions.style.display = 'flex';
    const paused = task.status === 'paused';
    els.btnPause.style.display = paused ? 'none' : 'block';
    els.btnResume.style.display = paused ? 'block' : 'none';
    els.progressTrack.style.opacity = paused ? '0.5' : '1';
  } else {
    actions.style.display = 'none';
  }

  if (task.progress !== undefined) {
    if (['permissions', 'indexing'].includes(task.status)) {
      els.progressPct.textContent = t(task.status === 'permissions' ? 'progress.finalizing' : 'progress.indexing');
      els.progressBar.style.width = '100%';
      els.progressBar.style.animation = 'pulse-bar 1.5s ease-in-out infinite';
      els.progressBar.style.opacity = '0.7';
      els.progressTrack.setAttribute('aria-valuenow', 100);
    } else {
      els.progressBar.style.animation = '';
      els.progressBar.style.opacity = '1';
      els.progressPct.textContent = task.status === 'paused' ? t('status.paused') : `${task.progress}%`;
      els.progressBar.style.width = `${task.progress}%`;
      els.progressTrack.setAttribute('aria-valuenow', task.progress || 0);
    }
  }

  els.progressSpeed.textContent = task.speed || '—';
  if (task.currentFile) els.progressFile.textContent = task.currentFile;
  else if (task.folderLabel) els.progressFile.textContent = task.folderLabel;
  if (task.transferTree) renderTransferTree(task.transferTree);

  if (['done', 'partial_success', 'error'].includes(task.status) && $('panel-step-4').hidden) showResult(task);
}

function destinationText(task) {
  const tg = task.target;
  if (!tg) return '—';
  return [tg.label, tg.subPath, task.parentFolder].filter(Boolean).join(' / ');
}

function formatDuration(start, end) {
  const s = Math.round((end - start) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function showResult(task) {
  goToStep(4);
  const status = task.status;
  const cls = { done: 'success', partial_success: 'warning', error: 'error' }[status] || 'error';
  els.resultIcon.className = `result-icon ${cls}`;
  els.resultIcon.textContent = { done: '✅', partial_success: '⚠️', error: '❌' }[status] || '❌';
  els.resultTitle.textContent = t(`result.title.${cls}`);
  els.resultSubtitle.textContent = status === 'done' ? t(task.target?.type === 'folder' ? 'result.subtitle.successFolder' : 'result.subtitle.success')
    : (task.error || t(status === 'partial_success' ? 'result.subtitle.warning' : 'result.subtitle.error'));

  const duration = task.startedAt ? formatDuration(new Date(task.startedAt), task.finishedAt ? new Date(task.finishedAt) : new Date()) : '—';
  const folders = task.sourceFolders || [];
  let scanInfo = `<span style="color:var(--amber);">${escHtml(t('result.notIndexed'))}</span>`;
  if (task.scanResult && task.scanResult.skipped) {
    scanInfo = escHtml(t('result.indexSkipped'));
  } else if (task.scanResult) {
    scanInfo = task.scanResult.success !== false
      ? `<span style="color:var(--teal);">${escHtml(t('result.indexed', { files: task.scanResult.files, folders: task.scanResult.folders }))}</span>`
      : `<span style="color:var(--amber);">${escHtml(t('result.indexFailed', { error: task.scanResult.error || 'occ' }))}</span>`;
  }
  const row = (k, v) => `<div class="rs-row"><span class="rs-key">${escHtml(k)}</span><span class="rs-val">${v}</span></div>`;
  els.resultSummary.innerHTML = [
    row(t('result.sources'), escHtml(t('result.sourcesValue', { count: folders.length, list: folders.join(', ') || '—' }))),
    row(t('result.destination'), escHtml(destinationText(task))),
    (task.macForks || []).length ? row(t('result.macFiles'), `<span style="color:var(--amber);">${escHtml(t('result.macFilesValue', { count: task.macForks.length }))}</span>`) : '',
    row(t('result.duration'), escHtml(duration)),
    row('Nextcloud', scanInfo),
  ].join('');
}

// ── Arborescence de transfert ─────────────────────────────────────────────
const TREE_ICONS = {
  pending: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" stroke-linecap="round"/></svg>',
  transferring: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" stroke-linecap="round"/></svg>',
  done: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 13l4 4L19 7" stroke-linecap="round"/></svg>',
};
function renderTransferTree(tree) {
  if (!tree || !tree.length) {
    els.transferTree.innerHTML = `<div class="tree-empty">${escHtml(t('progress.waiting'))}</div>`;
    return;
  }
  let html = '';
  for (const root of tree) {
    html += `<div class="tree-root" data-status="${escHtml(root.status)}"><span class="tree-status-icon">${TREE_ICONS[root.status] || ''}</span><span class="tree-root-name">${escHtml(root.name)}</span></div><div class="tree-child-list">`;
    const children = root.children.length ? root.children : [{ name: t('progress.rootFiles'), status: root.status, italic: true }];
    for (const child of children) {
      html += `<div class="tree-child" data-status="${escHtml(child.status)}"><div class="tree-status-icon">${TREE_ICONS[child.status] || TREE_ICONS.pending}</div><div class="tree-child-name"${child.italic ? ' style="font-style:italic"' : ''}>${escHtml(child.name)}</div></div>`;
    }
    html += '</div>';
  }
  els.transferTree.innerHTML = html;
  const activeNode = els.transferTree.querySelector('.tree-child[data-status="transferring"]');
  if (activeNode) activeNode.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ── Événements temps réel (SSE) ───────────────────────────────────────────
let sidebarRenderScheduled = false;
function scheduleSidebarRender() {
  if (sidebarRenderScheduled) return;
  sidebarRenderScheduled = true;
  setTimeout(() => { sidebarRenderScheduled = false; renderQueueSidebar(); }, 300);
}

function connectSSE() {
  if (evtSource) evtSource.close();
  evtSource = new EventSource('/api/events');
  evtSource.onmessage = (e) => {
    let data;
    try { data = JSON.parse(e.data); } catch { return; }

    if (data.type === 'init' || data.type === 'queueState') {
      queueData = data.queue || [];
      historyData = data.history || [];
      if (data.scan) updateScanStatusUI(data.scan);
      scheduleSidebarRender();
      if (currentViewTaskId) {
        const task = queueData.find(x => x.id === currentViewTaskId);
        if (task) {
          if (task.status !== 'queued') {
            if (!$('panel-step-0').hidden) { clearConsole(); batchLogs(task.logs || []); goToStep(3); }
            applyTaskState(task);
          }
        } else if (historyData.find(x => x.id === currentViewTaskId) && !$('panel-step-5').hidden) {
          viewHistoryTask(currentViewTaskId);
        }
      } else {
        const activeTask = queueData.find(x => ['transferring', 'permissions', 'indexing', 'paused'].includes(x.status));
        if (activeTask) viewTask(activeTask.id);
      }
    } else if (data.type === 'log') {
      if (data.taskId !== currentViewTaskId) return;
      queueLog(data.line);
      if (!$('panel-step-5').hidden) {
        const body = $('hist-log-body');
        body.insertAdjacentHTML('beforeend', renderLogLines([data.line]));
        body.scrollTop = body.scrollHeight;
      }
    } else if (data.type === 'progress') {
      const task = queueData.find(x => x.id === data.taskId);
      if (task) { task.progress = data.progress; task.speed = data.speed; task.status = 'transferring'; }
      if (data.taskId === currentViewTaskId) {
        els.progressPct.textContent = `${data.progress}%`;
        els.progressBar.style.width = `${data.progress}%`;
        els.progressTrack.setAttribute('aria-valuenow', data.progress);
        els.progressSpeed.textContent = data.speed;
        scheduleSidebarRender();
      }
    } else if (data.type === 'file') {
      const task = queueData.find(x => x.id === data.taskId);
      if (task) task.currentFile = data.currentFile;
      if (data.taskId === currentViewTaskId) els.progressFile.textContent = data.currentFile;
    } else if (data.type === 'scanState') {
      updateScanStatusUI(data.scan);
    }
  };
}

function updateScanStatusUI(scan) {
  const container = $('global-scan-status');
  const msgEl = $('global-scan-msg');
  const btn = $('btn-global-scan');
  const badge = $('scan-badge');
  const running = scan && scan.status === 'running';
  btn.disabled = running;
  btn.textContent = running ? t('scan.inProgress') : t('scan.full');
  badge.style.display = running ? 'inline-block' : 'none';
  if (!scan || scan.status === 'idle') { container.style.display = 'none'; return; }
  container.style.display = 'block';
  $('btn-cancel-scan').style.display = running ? '' : 'none';
  if (running && !$('scan-details-panel').open) $('scan-details-panel').open = true;
  msgEl.textContent = running ? scan.progressMessage
    : scan.status === 'done' ? `✅ ${scan.progressMessage}` : `❌ ${scan.error || ''}`;
}

// ── Panneau des transferts (file d'attente + historique) ─────────────────
function renderQueueSidebar() {
  const activeList = $('queue-active-list');
  const histList = $('queue-history-list');
  $('queue-active-count').textContent = queueData.length;
  const showCount = $('show-queue-count');
  showCount.textContent = queueData.length;
  showCount.hidden = queueData.length === 0;

  if (!queueData.length) {
    activeList.innerHTML = `<div class="queue-empty">${escHtml(t('queue.emptyActive'))}</div>`;
  } else {
    activeList.innerHTML = queueData.map((task, index) => {
      const running = ['transferring', 'permissions', 'indexing'].includes(task.status);
      const title = escHtml((task.sourceFolders || []).map(f => f.split('/').pop()).join(', '));
      const queued = task.status === 'queued';
      const canUp = queued && index > 0 && queueData[index - 1].status === 'queued';
      const canDown = queued && index < queueData.length - 1 && queueData[index + 1].status === 'queued';
      return `
        <div class="queue-task ${task.id === currentViewTaskId ? 'active' : ''}" data-status="${escHtml(task.status)}" data-action="view-task" data-id="${escHtml(task.id)}">
          <div class="queue-task-header">
            <div class="queue-task-title" title="${title}">${title}</div>
            <div class="queue-task-status">${escHtml(t(`queueStatus.${task.status}`))}</div>
          </div>
          ${task.progress > 0 && running ? `<div class="progress-track" style="height:4px;margin-top:4px;"><div class="progress-bar" style="width:${Number(task.progress) || 0}%"></div></div>` : ''}
          ${queued ? `<div class="queue-task-actions">
            <button data-action="reorder" data-dir="up" data-id="${escHtml(task.id)}" title="${escHtml(t('queue.up'))}" ${canUp ? '' : 'disabled'}>↑</button>
            <button data-action="reorder" data-dir="down" data-id="${escHtml(task.id)}" title="${escHtml(t('queue.down'))}" ${canDown ? '' : 'disabled'}>↓</button>
            <button class="btn-delete" data-action="remove-task" data-id="${escHtml(task.id)}" title="${escHtml(t('common.delete'))}">✕</button>
          </div>` : ''}
        </div>`;
    }).join('');
  }

  $('queue-history-count').textContent = historyData.length;
  if (!historyData.length) {
    histList.innerHTML = `<div class="queue-empty">${escHtml(t('queue.emptyHistory'))}</div>`;
  } else {
    const icons = { done: '✅', partial_success: '⚠️', error: '❌' };
    histList.innerHTML = historyData.map(task => {
      const title = escHtml((task.sourceFolders || []).map(f => f.split('/').pop()).join(', '));
      const date = task.finishedAt
        ? new Date(task.finishedAt).toLocaleDateString(I18N.locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : '';
      const dur = task.summary?.duration || '';
      return `
        <div class="history-item ${task.id === currentViewTaskId ? 'active' : ''}" data-action="view-history" data-id="${escHtml(task.id)}">
          <div class="history-item-icon">${icons[task.status] || '📄'}</div>
          <div class="history-item-body">
            <div class="history-item-title" title="${title}">${title}</div>
            <div class="history-item-meta">${escHtml(date)}${dur ? ' · ' + escHtml(dur) : ''}</div>
          </div>
          <button class="history-item-delete" data-action="remove-history" data-id="${escHtml(task.id)}" title="${escHtml(t('common.delete'))}">✕</button>
        </div>`;
    }).join('');
  }
}

// Délégation des clics dans le panneau (pas de onclick dans le HTML généré)
$('queue-sidebar').addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const id = el.dataset.id;
  switch (el.dataset.action) {
    case 'view-task': viewTask(id); break;
    case 'view-history': viewHistoryTask(id); break;
    case 'reorder': e.stopPropagation(); api('/api/queue/reorder', { method: 'POST', body: JSON.stringify({ id, direction: el.dataset.dir }) }).catch(() => {}); break;
    case 'remove-task': e.stopPropagation(); removeTask(id); break;
    case 'remove-history': e.stopPropagation(); removeHistory(id); break;
  }
});

function viewTask(id) {
  currentViewTaskId = id;
  const task = queueData.find(x => x.id === id);
  if (!task) { viewHistoryTask(id); return; }
  renderQueueSidebar();

  if (task.status === 'queued') {
    goToStep(0);
    $('task-preview-folders').innerHTML = (task.sourceFolders || [])
      .map(f => `<span class="folder-chip">📁 ${escHtml(f.split('/').pop() || f)}</span>`).join('');
    $('task-preview-destination').textContent = destinationText(task);
    $('btn-task-preview-delete').onclick = () => removeTask(id);
  } else {
    clearConsole();
    batchLogs(task.logs || []);
    goToStep(3);
    applyTaskState(task);
  }
}

async function removeTask(id) {
  try {
    await api(`/api/queue/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (currentViewTaskId === id) { currentViewTaskId = null; goToStep(1); }
  } catch (err) { alert(err.message); }
}

async function removeHistory(id) {
  try {
    await api(`/api/history/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (currentViewTaskId === id) { currentViewTaskId = null; goToStep(1); }
  } catch (err) { alert(err.message); }
}

// ── Détail d'une tâche terminée ───────────────────────────────────────────
async function viewHistoryTask(id) {
  currentViewTaskId = id;
  renderQueueSidebar();
  const task = historyData.find(x => x.id === id);
  if (!task) return;

  $('hist-status-icon').textContent = { done: '✅', partial_success: '⚠️', error: '❌' }[task.status] || '📄';
  $('title-step-5').textContent = (task.sourceFolders || []).map(f => f.split('/').pop()).join(', ') || t('hist.task');
  $('hist-subtitle').textContent = t(`status.${task.status}`);

  const s = task.summary || {};
  const date = task.finishedAt ? new Date(task.finishedAt).toLocaleString(I18N.locale, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  const card = (label, value, cls = '', style = '') =>
    `<div class="hist-stat-card"${style ? ` style="${style}"` : ''}><span class="hist-stat-label">${escHtml(label)}</span><span class="hist-stat-value ${cls}">${escHtml(value)}</span></div>`;
  $('hist-stats').innerHTML = [
    card(t('hist.date'), date),
    card(t('result.duration'), s.duration || '—', 'is-ok'),
    card(t('hist.folders'), s.folderCount ?? (task.sourceFolders || []).length),
    card(t('hist.errors'), s.errorCount || 0, (s.errorCount || 0) > 0 ? 'is-error' : ''),
    card(t('hist.warnings'), s.warningCount || 0, (s.warningCount || 0) > 0 ? 'is-warn' : ''),
    card(t('result.destination'), destinationText(task), 'hist-dest', 'grid-column:1/-1;'),
  ].join('');

  const highlights = [...(s.errorLines || []).map(l => ({ l, cls: '' })), ...(s.warningLines || []).map(l => ({ l, cls: 'is-warn' }))];
  $('hist-highlights').hidden = highlights.length === 0;
  $('hist-highlights-list').innerHTML = highlights.map(({ l, cls }) => `<div class="hist-highlight-line ${cls}">${escHtml(l)}</div>`).join('');

  $('btn-hist-delete').onclick = () => removeHistory(id);
  const rescanBtn = $('btn-hist-rescan');
  rescanBtn.disabled = false;
  rescanBtn.textContent = t('hist.rescan');
  rescanBtn.onclick = async () => {
    if (!confirm(t('hist.rescanConfirm', { count: (task.sourceFolders || []).length }))) return;
    rescanBtn.disabled = true;
    rescanBtn.textContent = t('hist.rescanRunning');
    try {
      await api('/api/scan/targeted-from-history', { method: 'POST', body: JSON.stringify({ taskId: id }) });
    } catch (err) {
      alert(err.message);
      rescanBtn.disabled = false;
      rescanBtn.textContent = t('hist.rescan');
    }
  };

  goToStep(5);
  const logBody = $('hist-log-body');
  logBody.innerHTML = `<div class="log-loading">${escHtml(t('hist.loadingLogs'))}</div>`;
  let logs = task.logs && task.logs.length ? task.logs : null;
  if (!logs) {
    try { logs = (await api(`/api/history/${encodeURIComponent(id)}/logs`)).logs || []; task.logs = logs; }
    catch (_) { logs = [t('hist.logsFailed')]; }
  }
  logBody.innerHTML = renderLogLines(logs);
  logBody.scrollTop = logBody.scrollHeight;

  document.querySelectorAll('.hist-filter').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === 'all');
    btn.onclick = () => {
      document.querySelectorAll('.hist-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const filter = btn.dataset.filter;
      const want = { error: 'log-error', warning: 'log-warn', success: 'log-success' }[filter];
      logBody.querySelectorAll('.console-line').forEach(span => {
        span.classList.toggle('hidden', filter !== 'all' && span.dataset.cat !== want);
      });
    };
  });
}

// ── Disques ───────────────────────────────────────────────────────────────
function formatSize(bytes) {
  if (!bytes) return '';
  const units = I18N.lang === 'fr' ? ['o', 'Ko', 'Mo', 'Go', 'To'] : ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let n = bytes;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
  return `${n.toLocaleString(I18N.locale, { maximumFractionDigits: n < 10 ? 1 : 0 })} ${units[i]}`;
}

async function scanUSB() {
  els.scanHint.textContent = t('source.searchingLong');
  try {
    disks = (await api('/api/disks')).disks || [];
  } catch (err) {
    els.scanHint.textContent = t('common.errorPrefix', { error: err.message });
    return;
  }
  renderDisks();
  if (currentVolume && !findVolume(currentVolume.id)?.mounted) closeBrowser();
}

function findVolume(id) {
  for (const d of disks) for (const v of d.volumes) if (v.id === id) return v;
  return null;
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderDisks() {
  els.diskList.innerHTML = '';
  if (!disks.length) { els.scanHint.textContent = t('source.noDisk'); return; }
  els.scanHint.textContent = t('source.diskCount', { count: disks.length });

  for (const disk of disks) {
    const card = el('div', 'disk-card' + (disk.ejected ? ' is-ejected' : ''));
    const head = el('div', 'disk-card-head');
    const title = el('div', 'disk-card-title', `💽 ${disk.model}`);
    title.appendChild(el('span', 'disk-card-size', formatSize(disk.size)));
    head.appendChild(title);
    if (disk.ejected) {
      head.appendChild(el('span', 'disk-card-ejected', t('source.canUnplug')));
    } else {
      const eject = el('button', 'btn btn-sm btn-eject', t('source.eject'));
      eject.title = t('source.ejectTitle');
      eject.addEventListener('click', () => ejectDisk(disk, eject));
      head.appendChild(eject);
    }
    card.appendChild(head);

    const list = el('div', 'volume-list');
    if (!disk.volumes.length) list.appendChild(el('div', 'volume-reason', t('source.noVolume')));
    for (const vol of disk.volumes) {
      const usable = vol.supported && vol.mounted && !disk.ejected;
      const btn = el('button', 'volume-btn' + (currentVolume && currentVolume.id === vol.id ? ' active' : ''));
      btn.disabled = !usable;
      btn.append(el('span', 'volume-name', vol.label), el('span', 'volume-meta', [vol.fsLabel, formatSize(vol.size)].filter(Boolean).join(' · ')));
      if (!usable && !disk.ejected) btn.appendChild(el('span', 'volume-reason', vol.reason || t('source.unavailable')));
      btn.addEventListener('click', () => openVolume(vol));
      list.appendChild(btn);
    }
    card.appendChild(list);
    els.diskList.appendChild(card);
  }
}

async function ejectDisk(disk, btn) {
  if (!confirm(t('source.ejectConfirm', { model: disk.model }))) return;
  btn.disabled = true;
  btn.textContent = t('source.ejecting');
  try {
    const data = await api(`/api/disks/${encodeURIComponent(disk.name)}/eject`, { method: 'POST' });
    const ids = new Set(disk.volumes.map(v => v.id));
    for (const [key, s] of selectedSources) if (ids.has(s.volumeId)) selectedSources.delete(key);
    updateSelectionUI();
    await scanUSB();
    alert(`✅ ${data.message}`);
  } catch (err) {
    alert(`⚠️ ${err.message}`);
    btn.disabled = false;
    btn.textContent = t('source.eject');
  }
}

// ── Navigateur de dossiers ────────────────────────────────────────────────
function openVolume(vol) {
  currentVolume = { id: vol.id, label: vol.label, fsType: vol.fsType };
  renderDisks();
  browse('');
}

function closeBrowser() {
  currentVolume = null;
  currentPath = '';
  currentFolders = [];
  els.folderSelectionArea.hidden = true;
  renderDisks();
}

async function browse(relPath) {
  if (!currentVolume) return;
  els.folderSelectionArea.hidden = false;
  els.folderHint.textContent = t('common.loading');
  els.folderGrid.innerHTML = `<div class="folder-grid-loading"><span>${escHtml(t('common.loading'))}</span></div>`;
  try {
    const qs = new URLSearchParams({ volume: currentVolume.id, path: relPath });
    const data = await api(`/api/disks/browse?${qs}`);
    currentPath = data.path;
    currentFolders = data.folders;
    currentFileCount = data.fileCount;
    renderBreadcrumb();
    renderFolderList();
  } catch (err) {
    els.folderHint.textContent = `⚠️ ${err.message}`;
    els.folderGrid.innerHTML = '';
  }
}

function renderBreadcrumb() {
  els.breadcrumb.innerHTML = '';
  const parts = currentPath ? currentPath.split('/') : [];
  const crumbs = [{ label: `💽 ${currentVolume.label}`, path: '' }]
    .concat(parts.map((p, i) => ({ label: p, path: parts.slice(0, i + 1).join('/') })));
  crumbs.forEach((c, i) => {
    if (i > 0) els.breadcrumb.appendChild(el('span', 'breadcrumb-sep', '›'));
    const b = el('button', 'breadcrumb-item', c.label);
    b.disabled = i === crumbs.length - 1;
    b.addEventListener('click', () => browse(c.path));
    els.breadcrumb.appendChild(b);
  });
  els.btnSelectCurrent.hidden = !currentPath;
  if (currentPath) {
    const selected = selectedSources.has(selKey(currentVolume.id, currentPath));
    els.btnSelectCurrent.textContent = t(selected ? 'source.currentSelected' : 'source.selectCurrent');
    els.btnSelectCurrent.classList.toggle('is-selected', selected);
  }
}

function historyBadge(f) {
  if (!f.history) return null;
  const span = el('span', `folder-history-badge ${f.history}`, t(`source.history.${f.history}`));
  span.title = t(f.historyLegacy ? 'source.historyLegacy' : 'source.historyExact');
  return span;
}

function renderFolderList() {
  els.folderGrid.innerHTML = '';
  els.folderHint.textContent = t('source.folderCount', { count: currentFolders.length })
    + (currentFileCount ? ' · ' + t('source.fileCount', { count: currentFileCount }) : '');
  if (!currentFolders.length) els.folderGrid.appendChild(el('div', 'folder-grid-empty', t('source.noSubfolder')));

  for (const f of currentFolders) {
    const key = selKey(currentVolume.id, f.path);
    const row = el('div', 'browser-row' + (selectedSources.has(key) ? ' selected' : ''));
    const check = el('input', 'browser-check');
    check.type = 'checkbox';
    check.checked = selectedSources.has(key);
    check.setAttribute('aria-label', t('source.selectFolder', { name: f.name }));
    check.addEventListener('change', () => toggleFolder(f));

    const open = el('button', 'browser-open');
    open.title = t('source.openFolder');
    open.append(el('span', '', '📁'), el('span', 'browser-name', f.name));
    const badge = historyBadge(f);
    if (badge) open.appendChild(badge);
    open.appendChild(el('span', 'browser-chevron', '›'));
    open.addEventListener('click', () => browse(f.path));

    row.append(check, open);
    els.folderGrid.appendChild(row);
  }
  els.btnSelectAll.hidden = currentFolders.length === 0;
  updateSelectAllLabel();
}

// ── Sélection ─────────────────────────────────────────────────────────────
function selKey(volumeId, p) { return `${volumeId}:${p}`; }
function isInside(child, parent) { return child.startsWith(parent + '/'); }

// Sélectionner un dossier ET l'un de ses sous-dossiers copierait deux fois les mêmes fichiers.
function addSelection(volumeId, volumeLabel, p, name) {
  for (const s of selectedSources.values()) {
    if (s.volumeId === volumeId && isInside(p, s.path)) {
      alert(t('source.alreadyInside', { name, parent: s.name }));
      return false;
    }
  }
  for (const [key, s] of selectedSources) {
    if (s.volumeId === volumeId && isInside(s.path, p)) selectedSources.delete(key);
  }
  selectedSources.set(selKey(volumeId, p), { volumeId, volumeLabel, path: p, name });
  return true;
}

function toggleFolder(f) {
  const key = selKey(currentVolume.id, f.path);
  if (selectedSources.has(key)) selectedSources.delete(key);
  else addSelection(currentVolume.id, currentVolume.label, f.path, f.name);
  refreshSelectionViews();
}

function refreshSelectionViews() {
  if (currentVolume) { renderFolderList(); renderBreadcrumb(); }
  updateSelectionUI();
}

function updateSelectionUI() {
  const count = selectedSources.size;
  els.selectionCountLabel.textContent = t('source.selectedCount', { count });
  els.selectionPanel.hidden = count === 0;
  els.btnStep1Next.disabled = count === 0;
  els.selectionList.innerHTML = '';
  for (const [key, s] of selectedSources) {
    const li = el('li');
    const txt = el('span', '', `${s.volumeLabel} › ${s.path.split('/').join(' › ')}`);
    txt.title = txt.textContent;
    const rm = el('button', 'selection-remove', '✕');
    rm.title = t('source.removeFromSelection');
    rm.addEventListener('click', () => { selectedSources.delete(key); refreshSelectionViews(); });
    li.append(txt, rm);
    els.selectionList.appendChild(li);
  }
  updateSelectAllLabel();
}

function updateSelectAllLabel() {
  if (!currentVolume) return;
  const all = currentFolders.length > 0 && currentFolders.every(f => selectedSources.has(selKey(currentVolume.id, f.path)));
  els.btnSelectAll.textContent = t(all ? 'source.uncheckAll' : 'source.checkAll');
}

els.btnSelectAll.addEventListener('click', () => {
  const all = currentFolders.every(f => selectedSources.has(selKey(currentVolume.id, f.path)));
  for (const f of currentFolders) {
    const key = selKey(currentVolume.id, f.path);
    if (all) selectedSources.delete(key);
    else if (!selectedSources.has(key)) addSelection(currentVolume.id, currentVolume.label, f.path, f.name);
  }
  refreshSelectionViews();
});

els.btnSelectCurrent.addEventListener('click', () => {
  if (!currentPath) return;
  const key = selKey(currentVolume.id, currentPath);
  if (selectedSources.has(key)) selectedSources.delete(key);
  else addSelection(currentVolume.id, currentVolume.label, currentPath, currentPath.split('/').pop());
  refreshSelectionViews();
});

els.btnClearSelection.addEventListener('click', () => { selectedSources.clear(); refreshSelectionViews(); });

// ── Destinations Nextcloud ────────────────────────────────────────────────
function targetValue(tg) { return tg ? `${tg.type}:${tg.id}` : ''; }

function fillTargetSelect(select, selected) {
  select.innerHTML = '';
  const addGroup = (label, items, type) => {
    if (!items.length) return;
    const og = document.createElement('optgroup');
    og.label = label;
    for (const it of items) {
      const opt = document.createElement('option');
      opt.value = `${type}:${it.id}`;
      opt.textContent = type === 'user' && it.name !== it.id ? `${it.name} (${it.id})` : it.name;
      og.appendChild(opt);
    }
    select.appendChild(og);
  };
  if (!targets.groups.length && !targets.users.length && !(targets.folders || []).length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = t('dest.noTargets');
    select.appendChild(opt);
    return;
  }
  addGroup(t('dest.groupFolders'), targets.groups, 'group');
  addGroup(t('dest.userFolders'), targets.users, 'user');
  addGroup(t('dest.folders'), targets.folders || [], 'folder');
  if (selected) select.value = selected;
}

async function loadTargets() {
  try {
    targets = await api('/api/targets');
  } catch (err) {
    targets = { groups: [], users: [], folders: [], default: null };
    els.targetHint.textContent = `⚠️ ${err.message}`;
  }
  fillTargetSelect(els.selectTarget, targetValue(targets.default));
  if (targets.default) els.inputTargetSubpath.value = targets.default.subPath || '';
}

function selectedTarget() {
  const [type, ...rest] = els.selectTarget.value.split(':');
  if (!type) return null;
  return { type, id: rest.join(':'), subPath: els.inputTargetSubpath.value.trim() };
}

function targetLabel(tg) {
  const list = { group: targets.groups, user: targets.users, folder: targets.folders || [] }[tg.type] || [];
  return (list.find(x => x.id === tg.id) || {}).name || tg.id;
}

function buildDestSummary() {
  const tg = selectedTarget();
  const parent = els.inputSubfolder.value.trim();
  els.destSummary.innerHTML = '';
  els.targetHint.textContent = tg ? t({ group: 'dest.hintGroup', user: 'dest.hintUser', folder: 'dest.hintFolder' }[tg.type]) : '';
  for (const s of selectedSources.values()) {
    const row = el('div', 'dest-row');
    const dstPath = tg ? [targetLabel(tg), tg.subPath, parent, s.name.normalize('NFC')].filter(Boolean).join(' / ') : '—';
    row.append(el('span', 'dest-row-src', `${s.volumeLabel}/${s.path}`), el('span', 'dest-row-arrow', '→'), el('span', 'dest-row-dst', dstPath));
    els.destSummary.appendChild(row);
  }
  els.btnStep2Launch.disabled = selectedSources.size === 0 || !tg;
}

async function launchTransfer() {
  const sources = [...selectedSources.values()].map(s => ({ volumeId: s.volumeId, path: s.path }));
  if (!sources.length) return;
  els.btnStep2Launch.disabled = true;
  try {
    const data = await api('/api/transfer', {
      method: 'POST',
      body: JSON.stringify({ sources, target: selectedTarget(), parentFolder: els.inputSubfolder.value.trim() }),
    });
    currentViewTaskId = data.taskId;
    selectedSources.clear();
    updateSelectionUI();
    goToStep(3);
    clearConsole();
    els.progressFile.textContent = t('progress.init');
    els.progressBar.style.width = '0%';
    els.progressPct.textContent = '0%';
    renderTransferTree([]);
    updateBadge('transferring');
    const state = await api('/api/status');
    queueData = state.queue || [];
    renderQueueSidebar();
    viewTask(data.taskId);
  } catch (err) {
    alert(err.message);
    els.btnStep2Launch.disabled = false;
  }
}

// ── Boutons des étapes ────────────────────────────────────────────────────
els.btnStep1Next.addEventListener('click', async () => {
  goToStep(2);
  if (!targets.groups.length && !targets.users.length && !(targets.folders || []).length) await loadTargets();
  buildDestSummary();
});
els.btnStep2Back.addEventListener('click', () => goToStep(1));
els.selectTarget.addEventListener('change', buildDestSummary);
els.inputTargetSubpath.addEventListener('input', buildDestSummary);
els.inputSubfolder.addEventListener('input', buildDestSummary);
els.btnStep2Launch.addEventListener('click', launchTransfer);

els.btnRescanUsb.addEventListener('click', async () => {
  els.btnRescanUsb.disabled = true;
  els.btnRescanUsb.textContent = t('source.detecting');
  try { await scanUSB(); }
  finally {
    els.btnRescanUsb.disabled = false;
    els.btnRescanUsb.textContent = t('source.detect');
  }
});

els.btnRefreshQueue.addEventListener('click', async () => {
  els.btnRefreshQueue.style.opacity = '0.5';
  try {
    const data = await api('/api/status');
    queueData = data.queue || [];
    historyData = data.history || [];
    renderQueueSidebar();
    const task = queueData.find(x => x.id === currentViewTaskId);
    if (task) applyTaskState(task);
  } catch (_) {}
  setTimeout(() => { els.btnRefreshQueue.style.opacity = '1'; }, 500);
});

els.btnAddTask.addEventListener('click', () => els.btnNewTransfer.click());

els.btnNewTransfer.addEventListener('click', () => {
  // On garde le disque ouvert pour enchaîner les transferts.
  currentViewTaskId = null;
  els.inputSubfolder.value = '';
  updateSelectionUI();
  clearConsole();
  renderTransferTree([]);
  updateBadge('idle');
  goToStep(1);
  scanUSB().then(() => { if (currentVolume) browse(currentPath); });
});

els.btnPause.addEventListener('click', () => { if (currentViewTaskId) api(`/api/transfer/pause/${currentViewTaskId}`, { method: 'POST' }).catch(() => {}); });
els.btnResume.addEventListener('click', () => { if (currentViewTaskId) api(`/api/transfer/resume/${currentViewTaskId}`, { method: 'POST' }).catch(() => {}); });
els.btnCancel.addEventListener('click', () => {
  if (currentViewTaskId && confirm(t('progress.cancelConfirm'))) {
    api(`/api/transfer/cancel/${currentViewTaskId}`, { method: 'POST' }).catch(() => {});
  }
});

// ── Indexation complète (maintenance) ─────────────────────────────────────
$('btn-global-scan').addEventListener('click', async () => {
  if (!confirm(t('scan.confirm'))) return;
  try { await api('/api/scan/global', { method: 'POST' }); }
  catch (err) { alert(err.message); }
});
$('btn-cancel-scan').addEventListener('click', async () => {
  if (!confirm(t('scan.cancelConfirm'))) return;
  try { await api('/api/scan/cancel', { method: 'POST' }); } catch (err) { alert(err.message); }
});

// ── Panneau des transferts : ouvrir / fermer ──────────────────────────────
// Ordinateur : panneau à droite de la page, fermable (choix mémorisé).
// Mobile / tablette : tiroir par-dessus la page, fermé par défaut.
const queueSidebar = $('queue-sidebar');
const btnToggleQueue = $('btn-toggle-queue');
const btnShowQueue = $('btn-show-queue');
const compactMq = window.matchMedia('(max-width: 1024px)');

function readStoredClosed() {
  try { return localStorage.getItem('tb.queueHidden') === '1'; } catch (_) { return false; }
}
function setQueueOpen(open, { remember = true } = {}) {
  document.body.classList.toggle('queue-closed', !open);
  document.body.classList.toggle('queue-open', open);
  btnShowQueue.setAttribute('aria-expanded', String(open));
  if (remember && !compactMq.matches) {
    try { localStorage.setItem('tb.queueHidden', open ? '0' : '1'); } catch (_) {}
  }
  if (open && compactMq.matches) btnToggleQueue.focus();
}
function applyQueueLayout() {
  setQueueOpen(compactMq.matches ? false : !readStoredClosed(), { remember: false });
}
btnToggleQueue.addEventListener('click', () => setQueueOpen(false));
btnShowQueue.addEventListener('click', () => setQueueOpen(true));
$('queue-backdrop').addEventListener('click', () => setQueueOpen(false));
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && compactMq.matches && document.body.classList.contains('queue-open')) setQueueOpen(false);
});
// Sur mobile, choisir une tâche ferme le tiroir pour montrer son détail.
queueSidebar.addEventListener('click', e => {
  if (!compactMq.matches) return;
  if (e.target.closest('#btn-add-task')) return setQueueOpen(false);
  if (e.target.closest('button')) return;
  if (e.target.closest('.queue-task, .history-item')) setQueueOpen(false);
});
if (compactMq.addEventListener) compactMq.addEventListener('change', applyQueueLayout);
applyQueueLayout();

// ── Paramètres : diagnostic + options ─────────────────────────────────────
const settingsModal = $('settings-modal');

function showSettingsTab(name) {
  document.querySelectorAll('.settings-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.settings-pane').forEach(p => { p.hidden = p.dataset.pane !== name; });
}
document.querySelectorAll('.settings-tab').forEach(b => b.addEventListener('click', () => showSettingsTab(b.dataset.tab)));

function renderDiagnostics(p) {
  const list = $('diag-list');
  list.innerHTML = '';
  for (const c of p.checks || []) {
    const icon = { ok: '✅', error: '❌', warn: '⚠️', info: 'ℹ️' }[c.level] || '•';
    const li = el('li', `diag-item diag-${c.level}`);
    li.appendChild(el('div', 'diag-detail', `${icon} ${c.detail}`));
    if (c.fix) li.appendChild(el('div', 'diag-fix', c.fix));
    list.appendChild(li);
  }
}

async function loadDiagnostics(refresh = false) {
  $('diag-list').innerHTML = `<li class="diag-item">${escHtml(t('settings.detecting'))}</li>`;
  try {
    const p = await api(`/api/platform${refresh ? '?refresh=1' : ''}`);
    renderDiagnostics(p);
    updateSetupBanner(p);
    return p;
  } catch (err) {
    $('diag-list').innerHTML = `<li class="diag-item diag-error">❌ ${escHtml(err.message)}</li>`;
    return null;
  }
}

function updateSetupBanner(p) {
  const blocking = (p.checks || []).filter(c => c.level === 'error');
  $('setup-banner').hidden = blocking.length === 0;
  $('setup-banner-text').textContent = blocking.length ? t('banner.text', { detail: blocking[0].detail }) : '';
}

async function loadSettingsForm() {
  const s = await api('/api/settings');
  await loadTargets();
  fillTargetSelect($('settings-target'), targetValue(s.target));
  $('settings-target-subpath').value = s.target?.subPath || '';
  $('settings-dir-mode').value = s.dirMode;
  $('settings-file-mode').value = s.fileMode;
  $('settings-bwlimit').value = s.bwlimit;
  $('settings-check-space').checked = s.checkSpace;
  $('settings-webhook').value = s.webhookUrl || '';
  $('settings-excludes').value = (s.excludes || []).join('\n');
}

async function openSettings(tab = 'diag') {
  showSettingsTab(tab);
  $('settings-error').hidden = true;
  settingsModal.showModal();
  loadDiagnostics();
  try { await loadSettingsForm(); } catch (err) { showSettingsError(err.message); }
}

function showSettingsError(msg) {
  $('settings-error').textContent = `⚠️ ${msg}`;
  $('settings-error').hidden = false;
}

$('btn-settings').addEventListener('click', () => openSettings('diag'));
$('btn-setup-banner').addEventListener('click', () => openSettings('diag'));
$('btn-close-settings').addEventListener('click', () => settingsModal.close());
$('btn-rediagnose').addEventListener('click', async () => {
  await loadDiagnostics(true);
  await loadTargets();
});

$('btn-save-settings').addEventListener('click', async () => {
  const btn = $('btn-save-settings');
  $('settings-error').hidden = true;
  const [type, ...rest] = $('settings-target').value.split(':');
  const body = {
    target: type ? { type, id: rest.join(':'), subPath: $('settings-target-subpath').value.trim() } : null,
    dirMode: $('settings-dir-mode').value.trim(),
    fileMode: $('settings-file-mode').value.trim(),
    bwlimit: Number($('settings-bwlimit').value || 0),
    checkSpace: $('settings-check-space').checked,
    webhookUrl: $('settings-webhook').value.trim(),
    excludes: $('settings-excludes').value.split(/\r?\n/).filter(l => l.trim()),
  };
  btn.disabled = true;
  try {
    await api('/api/settings', { method: 'POST', body: JSON.stringify(body) });
    await loadTargets();
    settingsModal.close();
  } catch (err) {
    showSettingsError(err.message);
  } finally {
    btn.disabled = false;
  }
});

// ── Langue ────────────────────────────────────────────────────────────────
$('btn-lang').addEventListener('click', async () => {
  await I18N.setLang(I18N.lang === 'fr' ? 'en' : 'fr');
  refreshTexts();
});

// Textes générés par le code, à refaire après un changement de langue.
function refreshTexts() {
  $('btn-lang').textContent = I18N.lang === 'fr' ? 'EN' : 'FR';
  // Textes fournis par le serveur (formats de disques, diagnostic) : on les redemande
  scanUSB();
  api('/api/platform').then(updateSetupBanner).catch(() => {});
  if (currentVolume) { renderBreadcrumb(); renderFolderList(); }
  updateSelectionUI();
  renderQueueSidebar();
  const task = queueData.find(x => x.id === currentViewTaskId);
  updateBadge(task ? task.status : 'idle');
  if (!$('panel-step-2').hidden) { fillTargetSelect(els.selectTarget, els.selectTarget.value); buildDestSummary(); }
}

// ── Connexion ─────────────────────────────────────────────────────────────
let loginShown = false;
function showLogin() {
  if (loginShown) return;
  loginShown = true;
  if (evtSource) evtSource.close();
  $('login-screen').hidden = false;
  $('login-password').focus();
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').hidden = true;
  const res = await fetch('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: $('login-password').value }),
  });
  if (!res.ok) { $('login-error').hidden = false; return; }
  location.reload();
});

$('btn-logout').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.reload();
});

// ── Démarrage ─────────────────────────────────────────────────────────────
(async function init() {
  await I18N.ready;
  $('btn-lang').textContent = I18N.lang === 'fr' ? 'EN' : 'FR';
  const auth = await fetch('/api/auth/status').then(r => r.json()).catch(() => ({}));
  if (auth.enabled && !auth.authenticated) { showLogin(); return; }
  $('btn-logout').hidden = !auth.canLogout;

  updateSelectionUI();
  renderTransferTree([]);
  connectSSE();
  await Promise.all([
    scanUSB(),
    api('/api/platform').then(updateSetupBanner).catch(() => {}),
  ]);
})();
