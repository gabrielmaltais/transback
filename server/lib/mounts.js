const path = require('path').posix;

// Traduction de chemins entre conteneurs à partir des montages Docker
// (tableau « Mounts » de `docker inspect` : { Source, Destination }).

function under(p, prefix) {
  return p === prefix || p.startsWith(prefix.endsWith('/') ? prefix : prefix + '/');
}

function longestMatch(mounts, p, key) {
  let best = null;
  for (const m of mounts || []) {
    const base = path.normalize(m[key]);
    if (under(p, base) && (!best || base.length > path.normalize(best[key]).length)) best = m;
  }
  return best;
}

/** Chemin vu dans un conteneur → chemin sur l'hôte (null si non monté). */
function containerToHost(p, mounts) {
  const norm = path.normalize(p);
  const m = longestMatch(mounts, norm, 'Destination');
  if (!m) return null;
  return path.join(path.normalize(m.Source), path.relative(path.normalize(m.Destination), norm));
}

/** Chemin sur l'hôte → chemin vu dans un conteneur (null si non monté). */
function hostToContainer(p, mounts) {
  const norm = path.normalize(p);
  const m = longestMatch(mounts, norm, 'Source');
  if (!m) return null;
  return path.join(path.normalize(m.Destination), path.relative(path.normalize(m.Source), norm));
}

/** Chemin dans le conteneur A → chemin dans le conteneur B, via l'hôte. */
function mapBetween(p, fromMounts, toMounts) {
  const host = containerToHost(p, fromMounts);
  if (!host) return { host: null, mapped: null };
  return { host, mapped: hostToContainer(host, toMounts) };
}

module.exports = { containerToHost, hostToContainer, mapBetween };
