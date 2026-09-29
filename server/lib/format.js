/** 1234567 → « 1,2 Mo » / « 1.2 MB » selon la langue. */
function formatBytes(bytes, lang = 'en') {
  const units = lang === 'fr' ? ['o', 'Ko', 'Mo', 'Go', 'To', 'Po'] : ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let n = Number(bytes) || 0;
  let i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
  return `${n.toLocaleString(lang === 'fr' ? 'fr-CA' : 'en-US', { maximumFractionDigits: n < 10 && i > 0 ? 1 : 0 })} ${units[i]}`;
}

/**
 * Sortie de `rsync --stats` (sans -h) → octets à transférer.
 * « Total transferred file size: 1,234,567 bytes » : les séparateurs de milliers sont retirés.
 */
function parseRsyncTransferSize(text) {
  const m = String(text || '').match(/Total transferred file size:\s*([\d,.]+)/i);
  return m ? Number(m[1].replace(/[,.]/g, '')) : null;
}

module.exports = { formatBytes, parseRsyncTransferSize };
