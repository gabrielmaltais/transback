const express = require('express');
const router = express.Router();
const configService = require('../services/configService');
const platform = require('../services/platformService');
const targetService = require('../services/targetService');

router.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

// GET /api/settings — réglages actuels
router.get('/settings', (req, res) => {
  res.json(configService.publicView());
});

// POST /api/settings — enregistre les réglages (validation côté serveur)
router.post('/settings', async (req, res) => {
  try {
    const body = req.body || {};
    // La destination par défaut doit exister dans Nextcloud
    if (body.target) await targetService.resolve(body.target);
    configService.save(body);
    res.json({ success: true, settings: configService.publicView() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/platform?refresh=1 — diagnostic de l'environnement
router.get('/platform', async (req, res) => {
  try {
    res.json(platform.publicView(await platform.detect({ force: req.query.refresh === '1' })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/targets — destinations Nextcloud disponibles (dossiers de groupe, utilisateurs)
router.get('/targets', async (req, res) => {
  try {
    const lists = await targetService.list();
    const def = configService.get().target;
    let defaultTarget = null;
    if (def) {
      try {
        const r = await targetService.resolve(def, { known: lists });
        defaultTarget = { type: r.type, id: r.id, subPath: r.subPath, label: r.label };
      } catch (_) {}
    }
    res.json({ ...lists, default: defaultTarget });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
