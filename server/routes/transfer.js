const express = require('express');
const router  = express.Router();
const queueService = require('../services/queueService');
const scanService = require('../services/scanService');
const { pauseTransfer, resumeTransfer, cancelTransfer } = require('../services/rsyncService');
const diskService = require('../services/diskService');
const { resolveSafe } = require('../lib/safePath');
const { validateParentFolder } = require('../lib/targetPath');
const targetService = require('../services/targetService');
const configService = require('../services/configService');
const { t } = require('../lib/i18n');

// ── SSE Clients ───────────────────────────────────────────────────────────────
const clients = [];
function pushSSE(payload) {
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  clients.forEach(c => { try { c.write(msg); } catch (_) {} });
}

queueService.setOnStateChange((stateOrNull, eventData) => {
  if (eventData) {
    pushSSE(eventData);
  } else {
    pushSSE({
      type: 'queueState',
      queue:   queueService.getQueueState(),
      history: queueService.getHistory(),
    });
  }
});

scanService.setOnScanStateChange((scanStatus) => {
  pushSSE({
    type: 'scanState',
    scan: scanStatus
  });
});

// ── Transfert ─────────────────────────────────────────────────────────────────
// Corps : { sources: [{ volumeId, path }], target: { type, id, subPath }, parentFolder }
router.post('/transfer', async (req, res) => {
  const { sources, target: rawTarget, parentFolder: rawParent = '' } = req.body || {};
  if (!Array.isArray(sources) || sources.length === 0) {
    return res.status(400).json({ error: t('err.noSelection') });
  }

  try {
    const parentFolder = validateParentFolder(rawParent);
    const target = await targetService.resolve(rawTarget || configService.get().target);
    const validated = [];
    for (const s of sources) {
      const rel = String((s && s.path) || '').replace(/^\/+|\/+$/g, '');
      const { root, volume } = await diskService.getVolumeRoot(String((s && s.volumeId) || ''));
      await resolveSafe(root, rel); // lève si le chemin sort du disque ou n'existe pas
      const destName = (rel ? rel.split('/').pop() : volume.label).normalize('NFC').replace(/[/\\]/g, '_');
      validated.push({ volumeId: volume.id, volumeLabel: volume.label, fsType: volume.fsType, path: rel, destName });
    }

    const names = validated.map(v => v.destName.toLocaleLowerCase());
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup) {
      return res.status(400).json({ error: t('err.duplicateNames', { name: validated[names.indexOf(dup)].destName }) });
    }

    const taskInfo = { type: target.type, id: target.id, subPath: target.subPath, label: target.label };
    const taskId = queueService.addTask(validated, taskInfo, parentFolder);
    res.json({ success: true, taskId });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Pause / Reprise / Annulation
router.post('/transfer/pause/:id',  (req, res) => {
  try { pauseTransfer(req.params.id);  res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
router.post('/transfer/resume/:id', (req, res) => {
  try { resumeTransfer(req.params.id); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
router.post('/transfer/cancel/:id', (req, res) => {
  try { cancelTransfer(req.params.id); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── File d'attente ────────────────────────────────────────────────────────────
router.get('/status', (req, res) => {
  res.json({
    queue:   queueService.getQueueState(),
    history: queueService.getHistory(),
    scan:    scanService.getScanStatus()
  });
});

router.post('/queue/reorder', (req, res) => {
  const { id, direction } = req.body;
  if (!id || !['up', 'down'].includes(direction)) {
    return res.status(400).json({ error: t('err.badParams') });
  }
  try { queueService.reorderTask(id, direction); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/queue/:id', (req, res) => {
  try { queueService.removeTask(req.params.id); res.json({ success: true }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// ── Historique ────────────────────────────────────────────────────────────────
router.delete('/history/:id', (req, res) => {
  try { queueService.removeHistory(req.params.id); res.json({ success: true }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.get('/history/:id/logs', (req, res) => {
  const task = queueService.getHistory().find(x => x.id === req.params.id);
  if (!task) return res.status(404).json({ error: t('err.taskNotFound') });
  res.json({ logs: task.logs || [], summary: task.summary || {} });
});

// ── Scans autonomes & ciblés ──────────────────────────────────────────────────
router.post('/scan/global', async (req, res) => {
  // On attend un court instant pour renvoyer les erreurs immédiates (destination absente,
  // scan déjà en cours) ; le scan continue ensuite en arrière-plan.
  const job = scanService.startGlobalScanJob();
  const early = await Promise.race([job.then(() => null, err => err), new Promise(r => setTimeout(() => r(null), 300))]);
  job.catch(err => console.error('Global scan error:', err.message));
  if (early) return res.status(400).json({ error: early.message });
  res.json({ success: true });
});

router.post('/scan/targeted-from-history', async (req, res) => {
  const { taskId } = req.body;
  if (!taskId) return res.status(400).json({ error: t('err.badParams') });

  const task = queueService.getTask(taskId);
  if (!task) return res.status(404).json({ error: t('err.taskNotFound') });

  res.json({ success: true });

  const logFn = (line) => queueService.pushHistoryLog(taskId, line);
  logFn('\n' + t('rescan.start', { date: new Date().toISOString() }));

  try {
    const { executePostProcess } = require('../services/postProcessService');
    const destNames = task.sources
      ? task.sources.map(s => s.destName)
      : (task.sourceFolders || []).map(f => f.split('/').pop().normalize('NFC'));
    // Tâches plus anciennes sans destination enregistrée : destination par défaut
    const target = await targetService.resolve(task.target || configService.get().target);
    await executePostProcess(
      logFn,
      (upd) => queueService.updateTaskInHistory(taskId, upd),
      () => {},
      target,
      destNames,
      task.parentFolder || ''
    );

    queueService.updateTaskInHistory(taskId, {
      status: task.error ? 'partial_success' : 'done',
      finishedAt: new Date().toISOString()
    });
    logFn(t('rescan.done') + '\n');
  } catch (err) {
    logFn(t('rescan.failed', { error: err.message }) + '\n');
    queueService.updateTaskInHistory(taskId, {
      status: 'error',
      error: err.message,
      finishedAt: new Date().toISOString()
    });
  }
});

router.post('/scan/cancel', (req, res) => {
  try {
    scanService.cancelScanJob();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SSE ───────────────────────────────────────────────────────────────────────
router.get('/events', (req, res) => {
  res.setHeader('Content-Type',     'text/event-stream');
  res.setHeader('Cache-Control',    'no-cache');
  res.setHeader('Connection',       'keep-alive');
  res.setHeader('X-Accel-Buffering','no');
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({
    type:    'init',
    queue:   queueService.getQueueState(),
    history: queueService.getHistory(),
    scan:    scanService.getScanStatus()
  })}\n\n`);

  clients.push(res);

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) {}
  }, 20000);

  req.on('close', () => {
    clearInterval(heartbeat);
    const idx = clients.indexOf(res);
    if (idx !== -1) clients.splice(idx, 1);
  });
});

module.exports = router;
