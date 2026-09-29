const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// Les anciens fichiers Mac (polices « suitcase », documents des années 90…) peuvent garder
// TOUT leur contenu dans la branche de ressources, que Nextcloud ne conserve pas : leur
// contenu principal est alors vide. On signale uniquement ces fichiers-là. Une branche de
// ressources à côté d'un contenu normal (aperçu, icône) est sans importance.
//   - hfs / hfsplus (noyau Linux) : branche lisible via « <fichier>/rsrc »
//   - apfs (apfs-fuse)            : attribut étendu com.apple.ResourceFork

const MAX_REPORTED = 500;

// Fichiers exclus de la copie : inutile de les signaler.
function isIgnored(name) {
  return name === 'Icon\r' || name === '.DS_Store' || name.startsWith('._');
}

async function detectHfs(root) {
  const found = [];
  const walk = async (dir) => {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (found.length >= MAX_REPORTED) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(p); continue; }
      if (!e.isFile() || isIgnored(e.name)) continue;
      try {
        if ((await fs.promises.stat(p)).size > 0) continue;
        if ((await fs.promises.stat(path.join(p, 'rsrc'))).size > 0) found.push(path.relative(root, p));
      } catch (_) {}
    }
  };
  await walk(root);
  return found;
}

// getfattr échappe les caractères spéciaux en octal (« Icon\015 »).
function unescapeOctal(s) {
  return s.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
}

function detectApfs(root) {
  return new Promise((resolve) => {
    execFile('getfattr', ['-R', '--absolute-names', '-m', '^com\\.apple\\.ResourceFork$', root],
      { maxBuffer: 64 * 1024 * 1024, timeout: 6 * 3600 * 1000 },
      async (_err, stdout) => {
        const found = [];
        const files = (stdout || '').split('\n')
          .filter(l => l.startsWith('# file: '))
          .map(l => unescapeOctal(l.slice(8)));
        for (const f of files) {
          if (found.length >= MAX_REPORTED) break;
          if (isIgnored(path.basename(f))) continue;
          try {
            const st = await fs.promises.stat(f);
            if (st.isFile() && st.size === 0) found.push(path.relative(root, f));
          } catch (_) {}
        }
        resolve(found);
      });
  });
}

/** Chemins (relatifs à `root`) des fichiers vides dont tout le contenu est dans la branche de ressources. */
async function detectResourceForks(root, fsType) {
  if (fsType === 'hfs' || fsType === 'hfsplus') return detectHfs(root);
  if (fsType === 'apfs') return detectApfs(root);
  return [];
}

module.exports = { detectResourceForks, MAX_REPORTED };
