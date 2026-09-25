function modelIdFromAnchor(anchor) {
  try {
    const url = new URL(anchor);
    const queryModel = url.searchParams.get('model');
    if (queryModel) return queryModel;
    return decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, '');
  } catch { return ''; }
}

function pathModelIdFromAnchor(anchor) {
  try {
    const url = new URL(anchor);
    if (url.searchParams.has('model')) return '';
    return decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, '');
  } catch { return ''; }
}

function comparablePathModelId(value) {
  return String(value || '').trim().toLowerCase().replace(/[._]+/g, '-').replace(/-+/g, '-');
}

function modelCandidates(model, rows) {
  if (model.adapter === 'veo') {
    const tier = { veo3: 'Quality', veo3_fast: 'Fast', veo3_lite: 'Lite' }[model.wireModel];
    const mode = { TEXT_2_VIDEO: 'text-to-video', FIRST_AND_LAST_FRAMES_2_VIDEO: 'image-to-video',
      REFERENCE_2_VIDEO: 'reference-to-video' }[model.mode];
    if (!tier || !mode) return [];
    return rows.filter(row => comparablePathModelId(pathModelIdFromAnchor(row.anchor)) === 'veo-3-1'
      && new RegExp(`^Google veo 3\\.1,\\s*${mode},\\s*${tier}-`, 'i').test(String(row.modelDescription || '')));
  }

  const aliases = new Set([model.apiModel, model.id?.replace(/^kie:/, '')].filter(Boolean));
  const exact = rows.filter(row => aliases.has(modelIdFromAnchor(row.anchor)));
  if (exact.length) return exact;

  // Kie publishes this model's output tiers on a shared page without ?model=.
  if (model.apiModel === 'seedream/5-pro-image-to-image') {
    const shared = rows.filter(row => comparablePathModelId(pathModelIdFromAnchor(row.anchor)) === 'seedream-5-0-pro'
      && /^seedream 5(?:\.0)? pro,\s*image-to-image,\s*(?:1K|2K)$/i.test(String(row.modelDescription || '')));
    if (shared.length) return shared;
  }

  // A description may carry the exact API id while the URL is a marketing page.
  // An explicit, different ?model= id is always authoritative.
  const described = rows.filter(row => {
    if (!pathModelIdFromAnchor(row.anchor)) return false;
    const [descriptionId, mode] = String(row.modelDescription || '').split(',').map(part => part.trim());
    return aliases.has(descriptionId)
      || (/^(?:text|image)-to-image$/i.test(mode) && aliases.has(`${descriptionId}-${mode}`));
  });
  if (described.length) return described;

  // Full namespaced API ids may be flattened in a path, e.g. wan/2-7-image.
  const flattened = new Set([...aliases]
    .map(alias => comparablePathModelId(alias.replaceAll('/', '-')))
    .filter(Boolean));
  const fullPath = rows.filter(row => flattened.has(comparablePathModelId(pathModelIdFromAnchor(row.anchor))));
  if (fullPath.length) return fullPath;

  // Namespace-free paths are a last resort, only without an explicit ?model=.
  const suffixes = new Set([...aliases]
    .map(alias => comparablePathModelId(alias.split('/').pop()))
    .filter(Boolean));
  return rows.filter(row => suffixes.has(comparablePathModelId(pathModelIdFromAnchor(row.anchor))));
}

module.exports = { modelIdFromAnchor, modelCandidates };
