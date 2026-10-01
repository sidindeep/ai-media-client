const seed = require('../../config/model-routes.json');
const { transaction } = require('../database/database');
const { normalizeRows, validateDocument, publicRows } = require('./model-route-document');
const ID = 'model-routes';
const titles = { all: 'Все модели с ценой', shared: 'Модели с ID Kie и APIMart' };

async function readRouteDocument(pool) {
  const row = (await pool.query('SELECT source_version,models FROM media_model_routes WHERE id=$1', [ID])).rows[0];
  if (!row) throw new Error('Единая таблица моделей не настроена');
  return validateDocument({ version: row.source_version, models: row.models });
}
async function ensureCurrentModelConfig(pool) {
  return transaction(pool, async db => {
    await db.query('SELECT pg_advisory_xact_lock(18274692)');
    const stored = (await db.query('SELECT source_version,models FROM media_model_routes WHERE id=$1', [ID])).rows[0];
    if (stored?.models.length && stored.models.every(row => row.id && row.providers)) {
      const models = normalizeRows(stored.models);
      validateDocument({ version: stored.source_version, models });
      if (stored.models.some((row, index) => row.action !== models[index].action))
        await db.query('UPDATE media_model_routes SET models=$1::jsonb,updated_at=now() WHERE id=$2', [JSON.stringify(models), ID]);
      return ID;
    }
    const key = row => row.providers.kie || JSON.stringify(row.providers);
    const merged = new Map(normalizeRows(stored?.models || []).map(row => [key(row), row]));
    for (const row of seed.models) merged.set(key(row), row);
    const paired = new Set([...merged.values()].filter(row => row.providers.kie).map(row => row.providers.apimart).filter(Boolean));
    const models = [...merged.values()].filter(row => row.providers.kie || !paired.has(row.providers.apimart));
    validateDocument({ version: seed.version, models });
    await db.query(
      'INSERT INTO media_model_routes(id,source_version,models) VALUES($1,$2,$3::jsonb) ON CONFLICT(id) DO UPDATE SET source_version=excluded.source_version,models=excluded.models,updated_at=now()',
      [ID, seed.version, JSON.stringify(models)]);
    return ID;
  });
}
function view(document, variant = 'all') {
  const priced = publicRows(document.models).filter(row => Object.values(row.publishedTariffs).some(price => price && price !== '—'));
  return { id: variant === 'shared' ? ID + '/shared' : ID, version: document.version,
    variant, title: titles[variant], baseVersion: document.version,
    models: variant === 'shared' ? priced.filter(row => row.kie && row.apimart) : priced };
}
async function currentModelConfig(pool) { return view(await readRouteDocument(pool)); }
async function modelConfigById(pool, id) {
  if (![ID, ID + '/shared'].includes(id)) return null;
  return view(await readRouteDocument(pool), id.endsWith('/shared') ? 'shared' : 'all');
}
async function listModelConfigs(pool) {
  const document = await readRouteDocument(pool);
  return ['all', 'shared'].map(variant => {
    const result = view(document, variant);
    return { ...result, models: undefined, isCurrent: variant === 'all', modelCount: result.models.length };
  });
}
async function saveModelConfig(pool, config) {
  const document = validateDocument({ version: config.version, models: normalizeRows(config.models || []) });
  if (config.variant === 'shared') throw new Error('Импортируйте полную единую таблицу, а не фильтр общих моделей');
  await transaction(pool, async db => {
    await db.query('SELECT pg_advisory_xact_lock(18274692)');
    await db.query('INSERT INTO media_model_routes(id,source_version,models) VALUES($1,$2,$3::jsonb) ON CONFLICT(id) DO UPDATE SET source_version=excluded.source_version,models=excluded.models,updated_at=now()',
      [ID, document.version, JSON.stringify(document.models)]);
  });
  return ID;
}
async function activateModelConfig(pool, id) {
  if (id !== ID) throw new Error('Существует одна единая таблица моделей; вкладки являются фильтрами');
  await readRouteDocument(pool);
}
function createModelConfigReader(pool) {
  return Object.freeze({ current: () => currentModelConfig(pool), list: () => listModelConfigs(pool),
    get: id => modelConfigById(pool, id) });
}

module.exports = { ensureCurrentModelConfig, currentModelConfig, modelConfigById, saveModelConfig, listModelConfigs, activateModelConfig, readRouteDocument, createModelConfigReader };
