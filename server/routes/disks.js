const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const diskService = require('../services/diskService');
const queueService = require('../services/queueService');
const { lookup } = require('../services/historyService');
const { resolveSafe } = require('../lib/safePath');

// Dossiers système masqués dans le navigateur.
const HIDDEN_NAMES = new Set(['$RECYCLE.BIN', 'System Volume Information', 'lost+found']);

router.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

// GET /api/disks — disques USB détectés (montage automatique des formats pris en charge)
router.get('/', async (req, res) => {
  try {
    res.json({ disks: await diskService.refresh() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/disks/browse?volume=<id>&path=<relatif>
router.get('/browse', async (req, res) => {
  const volumeId = String(req.query.volume || '');
  const rel = String(req.query.path || '').replace(/^\/+|\/+$/g, '');
  try {
    const { root, volume } = await diskService.getVolumeRoot(volumeId);
    const dir = await resolveSafe(root, rel);
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });

    const folders = [];
    let fileCount = 0;
    for (const e of entries) {
      if (e.name.startsWith('.') || HIDDEN_NAMES.has(e.name)) continue;
      let isDir = e.isDirectory();
      if (!isDir && !e.isFile() && !e.isSymbolicLink()) {
        // Certains pilotes FUSE ne renseignent pas le type : on vérifie.
        try { isDir = (await fs.promises.stat(path.join(dir, e.name))).isDirectory(); } catch (_) {}
      }
      if (!isDir) { if (e.isFile()) fileCount++; continue; }
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      const h = lookup(volumeId, relPath);
      folders.push({ name: e.name, path: relPath, history: h ? h.status : null, historyLegacy: h ? h.legacy : false });
    }
    folders.sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true, sensitivity: 'base' }));

    res.json({ volume: { id: volume.id, label: volume.label, fsType: volume.fsType }, path: rel, folders, fileCount });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/disks/:name/eject — éjecte tous les volumes d'un disque physique
router.post('/:name/eject', async (req, res) => {
  try {
    const result = await diskService.eject(req.params.name, ids => queueService.volumesBusyReason(ids));
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
