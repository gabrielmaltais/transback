const crypto = require('crypto');

// Authentification optionnelle :
//   TB_PASSWORD=…            → page de connexion, session par cookie (HttpOnly, SameSite=Lax)
//   TB_TRUST_PROXY_AUTH=hdr  → accès accordé si l'en-tête « hdr » est présent
//                              (ex. Cf-Access-Authenticated-User-Email derrière Cloudflare Access,
//                               Remote-User derrière Authelia/Authentik)
// Sans l'un ni l'autre, TransBack est ouvert (le diagnostic l'indique).

const PASSWORD = process.env.TB_PASSWORD || '';
const PROXY_HEADER = (process.env.TB_TRUST_PROXY_AUTH || '').toLowerCase();
const COOKIE = 'tb_session';
const SESSION_TTL = 7 * 24 * 3600 * 1000;

const sessions = new Map(); // jeton → expiration
let failedAttempts = 0;

function isEnabled() { return Boolean(PASSWORD || PROXY_HEADER); }
function mode() { return PASSWORD ? 'password' : (PROXY_HEADER ? `proxy:${PROXY_HEADER}` : 'none'); }

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function isAuthenticated(req) {
  if (!isEnabled()) return true;
  if (PROXY_HEADER && req.headers[PROXY_HEADER]) return true;
  if (PASSWORD) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const exp = token && sessions.get(token);
    if (exp && exp > Date.now()) return true;
    if (token) sessions.delete(token);
  }
  return false;
}

async function login(password, res, secure) {
  // Ralentit les essais répétés (au plus ~5 s d'attente).
  if (failedAttempts > 0) await new Promise(r => setTimeout(r, Math.min(5000, failedAttempts * 500)));
  if (!PASSWORD || !safeEqual(password || '', PASSWORD)) {
    failedAttempts++;
    return false;
  }
  failedAttempts = 0;
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL);
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL / 1000}${secure ? '; Secure' : ''}`);
  return true;
}

function logout(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

/** Middleware : protège /api/* sauf /api/auth/*. */
function middleware(req, res, next) {
  if (!req.path.startsWith('/api/') || req.path.startsWith('/api/auth/')) return next();
  if (isAuthenticated(req)) return next();
  res.status(401).json({ error: 'auth_required' });
}

module.exports = { isEnabled, mode, isAuthenticated, login, logout, middleware, parseCookies, safeEqual };
