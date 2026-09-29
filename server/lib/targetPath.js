const { t } = require('./i18n');

// Validation des destinations.
// Une destination est { type: 'group' | 'user' | 'folder', id, subPath } :
//   group  → <données Nextcloud>/__groupfolders/<id>/files/<subPath>
//   user   → <données Nextcloud>/<id>/files/<subPath>
//   folder → <TB_DESTINATIONS_ROOT>/<id>/<subPath>  (sans Nextcloud, pas d'indexation)

function validName(seg) {
  return seg && seg !== '.' && seg !== '..' && !seg.startsWith('.') && !/[\\\0]/.test(seg) && !seg.includes('/');
}

/** Nom de sous-dossier parent : un seul niveau, pas de caractères dangereux. */
function validateParentFolder(input) {
  const name = (input || '').trim().normalize('NFC');
  if (!name) return '';
  if (!validName(name)) throw new Error(t('err.parentInvalid'));
  return name;
}

/** Sous-chemin dans la destination (« Archives/2024 ») : segments validés, NFC. */
function validateSubPath(input) {
  const raw = (input || '').trim().normalize('NFC').replace(/^\/+|\/+$/g, '');
  if (!raw) return '';
  const segs = raw.split('/').map(s => s.trim());
  if (segs.some(s => !validName(s))) throw new Error(t('err.subPathInvalid'));
  return segs.join('/');
}

/** Forme d'une destination (l'existence est vérifiée par targetService). */
function validateTargetSpec(spec) {
  if (!spec || typeof spec !== 'object') throw new Error(t('err.targetMissing'));
  const type = spec.type;
  const id = String(spec.id ?? '').trim();
  if (type === 'group') {
    if (!/^\d+$/.test(id)) throw new Error(t('err.targetInvalid'));
  } else if (type === 'user' || type === 'folder') {
    if (!validName(id)) throw new Error(t('err.targetInvalid'));
  } else {
    throw new Error(t('err.targetInvalid'));
  }
  return { type, id, subPath: validateSubPath(spec.subPath) };
}

/** Ancienne config v2 : « …/__groupfolders/<id>/files[/sous/dossier] » → destination. */
function parseLegacyTarget(folder) {
  const m = String(folder || '').match(/__groupfolders\/(\d+)\/files\/?(.*)$/);
  if (!m) return null;
  try { return validateTargetSpec({ type: 'group', id: m[1], subPath: m[2] }); } catch (_) { return null; }
}

module.exports = { validateParentFolder, validateSubPath, validateTargetSpec, parseLegacyTarget };
