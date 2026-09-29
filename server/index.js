const express = require('express');
const path = require('path');
const auth = require('./services/authService');
const platform = require('./services/platformService');
const i18n = require('./lib/i18n');
const { LANG } = i18n;

const app = express();
const PORT = process.env.PORT || 3000;
// Sites autorisés à intégrer TransBack dans un cadre (ex. « https://cloud.example.com »
// pour l'app Nextcloud External sites). Par défaut : uniquement TransBack lui-même.
const FRAME_ANCESTORS = process.env.TB_FRAME_ANCESTORS || "'self'";

app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));
app.use(i18n.middleware);

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', `frame-ancestors ${FRAME_ANCESTORS}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// Fichiers de l'interface sans cache (mises à jour visibles immédiatement)
app.use(express.static(path.join(__dirname, '..', 'public'), {
  etag: false,
  maxAge: 0,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}));

app.use('/api/auth', require('./routes/auth'));
app.use(auth.middleware);
app.use('/api/disks', require('./routes/disks'));
app.use('/api', require('./routes/settings'));
app.use('/api', require('./routes/transfer'));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`TransBack listening on http://0.0.0.0:${PORT} (lang: ${LANG}, auth: ${auth.mode()})`);
  // Première détection en arrière-plan : le diagnostic est prêt à l'ouverture de l'interface
  platform.detect().then(p => {
    for (const c of platform.publicView(p).checks) console.log(`  [${c.level}] ${c.detail}`);
  }).catch(err => console.error('Detection failed:', err.message));
});
