// Notification de fin de tâche par webhook (POST JSON).
// Le corps contient à la fois « text » (Slack, Mattermost, ntfy via JSON…) et « content » (Discord),
// ainsi que les détails structurés pour les outils d'automatisation (n8n, Home Assistant…).

async function postWebhook(url, payload, log = () => {}) {
  if (!url) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'TransBack' },
      body: JSON.stringify({ text: payload.message, content: payload.message, ...payload }),
      signal: controller.signal,
    });
    if (!res.ok) log(`⚠️ Webhook : HTTP ${res.status}`);
  } catch (err) {
    log(`⚠️ Webhook : ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { postWebhook };
