const express = require('express');
const router = express.Router();
const auth = require('../services/authService');

// GET /api/auth/status — l'interface décide d'afficher ou non la page de connexion
router.get('/status', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ enabled: auth.isEnabled(), mode: auth.mode(), authenticated: auth.isAuthenticated(req), canLogout: auth.mode() === 'password' });
});

router.post('/login', async (req, res) => {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const ok = await auth.login((req.body || {}).password, res, secure);
  if (!ok) return res.status(401).json({ error: 'invalid_password' });
  res.json({ success: true });
});

router.post('/logout', (req, res) => {
  auth.logout(req, res);
  res.json({ success: true });
});

module.exports = router;
