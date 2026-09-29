const fs = require('fs');
const path = require('path');

// Les disques Mac (HFS+, APFS) stockent souvent les noms en Unicode décomposé
// (NFD : « e » + accent). Nextcloud attend du NFC. Si une copie précédente a
// déjà été normalisée, les deux variantes peuvent coexister : on fusionne.

async function lstatOrNull(p) {
  try { return await fs.promises.lstat(p); } catch (_) { return null; }
}

async function resolveFileConflict(src, dst, log, stats) {
  const [s, d] = await Promise.all([fs.promises.lstat(src), fs.promises.lstat(dst)]);
  if (s.mtimeMs > d.mtimeMs) {
    await fs.promises.rename(src, dst);
  } else {
    await fs.promises.unlink(src);
  }
  stats.merged++;
  log(`     Doublon NFC/NFD fusionné (version la plus récente conservée) : ${dst}`);
}

async function mergeDir(src, dst, log, stats) {
  const entries = await fs.promises.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const from = path.join(src, e.name);
    const to = path.join(dst, e.name);
    const existing = await lstatOrNull(to);
    if (!existing) {
      await fs.promises.rename(from, to);
    } else if (e.isDirectory() && existing.isDirectory()) {
      await mergeDir(from, to, log, stats);
    } else if (!e.isDirectory() && !existing.isDirectory()) {
      await resolveFileConflict(from, to, log, stats);
    } else {
      await fs.promises.rename(from, await freeName(to));
    }
  }
  await fs.promises.rmdir(src);
}

async function freeName(p) {
  for (let i = 2; ; i++) {
    const candidate = `${p} (${i})`;
    if (!(await lstatOrNull(candidate))) return candidate;
  }
}

/**
 * Renomme récursivement en NFC tout ce qui se trouve sous `dir`
 * (`dir` lui-même n'est pas renommé). Retourne les compteurs.
 */
async function normalizeTree(dir, log = () => {}, stats = { renamed: 0, merged: 0 }) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    log(`   ⚠️ Lecture impossible de ${dir} : ${err.message}`);
    return stats;
  }

  for (const e of entries) {
    const original = path.join(dir, e.name);
    let current = original;
    const nfc = e.name.normalize('NFC');

    try {
      if (nfc !== e.name) {
        const target = path.join(dir, nfc);
        const existing = await lstatOrNull(target);
        current = target;
        if (!existing) {
          await fs.promises.rename(original, target);
          stats.renamed++;
        } else if (e.isDirectory() && existing.isDirectory()) {
          await mergeDir(original, target, log, stats);
          stats.merged++;
        } else if (!e.isDirectory() && !existing.isDirectory()) {
          await resolveFileConflict(original, target, log, stats);
        } else {
          current = await freeName(target);
          await fs.promises.rename(original, current);
          stats.renamed++;
          log(`   ⚠️ Conflit fichier/dossier, renommé en : ${current}`);
        }
      }
    } catch (err) {
      log(`   ⚠️ Normalisation impossible pour ${original} : ${err.message}`);
      continue;
    }

    const st = await lstatOrNull(current);
    if (st && st.isDirectory()) {
      await normalizeTree(current, log, stats);
    }
  }
  return stats;
}

module.exports = { normalizeTree };
