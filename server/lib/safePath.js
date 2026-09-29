const fs = require('fs');
const path = require('path');

/**
 * Résout `rel` sous `root` et garantit que le résultat (liens symboliques
 * résolus) reste à l'intérieur de `root`. Lève une erreur sinon.
 */
async function resolveSafe(root, rel = '') {
  if (typeof rel !== 'string' || rel.includes('\0')) {
    throw new Error('Chemin invalide.');
  }
  const realRoot = await fs.promises.realpath(root);
  const candidate = path.resolve(realRoot, '.' + path.sep + rel);
  const real = await fs.promises.realpath(candidate);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw new Error('Chemin hors du disque refusé.');
  }
  return real;
}

module.exports = { resolveSafe };
