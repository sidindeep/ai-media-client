const { actions, inferAction } = require('../media/task-actions');
const projectIds = {
  'kie:gpt-image-2-text-to-image': 'gpt-image-2.text-to-image',
  'kie:gpt-image-2-image-to-image': 'gpt-image-2.image-to-image',
  'kie:nano-banana-pro': 'nano-banana-pro.image',
  'kie:nano-banana-2': 'nano-banana-2.image',
  'kie:google/nano-banana': 'nano-banana.image',
  'kie:flux-2/pro-text-to-image': 'flux-2-pro.text-to-image',
  'kie:flux-2/pro-image-to-image': 'flux-2-pro.image-to-image',
  'kie:seedream/4.5-text-to-image': 'seedream-4.5.text-to-image',
  'kie:seedream/4.5-edit': 'seedream-4.5.image-to-image',
  'kie:grok-imagine/image-to-image': 'grok-imagine.image-to-image',
  'kie:grok-imagine/text-to-image': 'grok-imagine.text-to-image',
};
function normalizeRows(rows) {
  return rows.map(row => {
    const providers = row.providers || Object.fromEntries(['kie', 'apimart'].filter(key => row[key]).map(key => [key, row[key]]));
    const sourceId = providers.kie || Object.values(providers)[0];
    const id = row.id || projectIds[sourceId] || `${row.kind}.${sourceId.replace(/^(kie|apimart):/, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '.')}`;
    return { providers, kind: row.kind, name: row.name,
      action: row.action || inferAction({ ...row, id, providers }),
      publishedTariffs: row.publishedTariffs || { kie: row.kiePrice || '', apimart: row.apimartPrice || '' }, id };
  });
}
function validateDocument(document) {
  if (!document || typeof document.version !== 'string' || !Array.isArray(document.models) || !document.models.length)
    throw new Error('Некорректная единая таблица моделей');
  const ids = new Set();
  for (const row of document.models) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(row.id || '') || ids.has(row.id)
      || !['text', 'image', 'video', 'audio'].includes(row.kind) || typeof row.name !== 'string' || !actions.has(row.action)
      || !row.providers || !Object.keys(row.providers).length
      || Object.entries(row.providers).some(([key, id]) => !/^[a-z][a-z0-9-]*$/.test(key) || typeof id !== 'string' || !id.trim()))
      throw new Error(`Некорректная или повторяющаяся строка модели: ${row.id}`);
    ids.add(row.id);
  }
  return document;
}
function publicRows(rows) {
  return rows.map(row => ({ ...row, kie: row.providers.kie || null, apimart: row.providers.apimart || null,
    kiePrice: row.publishedTariffs.kie || '', apimartPrice: row.publishedTariffs.apimart || '' }));
}
module.exports = { normalizeRows, validateDocument, publicRows };
