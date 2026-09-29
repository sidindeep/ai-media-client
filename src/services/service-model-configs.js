const initial = require('../../config/service-models.json');
const shared = require('../../config/service-models-v2.json');
const { transaction } = require('../database/database');

const initialId = `initial-${initial.version}`;
const titles = { all: initial.title, shared: shared.title };

async function ensureCurrentModelConfig(pool) {
  return transaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock(18274692)');
    const current = await client.query('SELECT id FROM media_service_model_configs WHERE is_current');
    if (!current.rows.length) await client.query(`INSERT INTO media_service_model_configs(id,source_version,models,is_current)
      VALUES($1,$2,$3::jsonb,false) ON CONFLICT(id) DO NOTHING`,
    [initialId, initial.version, JSON.stringify(initial.models)]);
    await client.query(`INSERT INTO media_service_model_configs
      (id,source_version,models,variant,title,base_version)
      VALUES($1,$2,$3::jsonb,'shared',$4,$5) ON CONFLICT(id) DO NOTHING`,
    [`shared-${shared.version}`, shared.version, JSON.stringify(shared.models), titles.shared, shared.baseVersion]);
    await client.query(`UPDATE media_service_model_configs SET title=CASE variant
      WHEN 'shared' THEN $1 ELSE $2 END
      WHERE (variant='shared' AND title='Наш сервис 2')
         OR (variant='all' AND title='Наш сервис 1')`, [titles.shared, titles.all]);
    if (!current.rows.length) await client.query(`UPDATE media_service_model_configs
      SET is_current=true,activated_at=now() WHERE id=$1`, [`shared-${shared.version}`]);
    return current.rows[0]?.id || `shared-${shared.version}`;
  });
}

function mapConfig(row) {
  return row ? { id: row.id, version: row.source_version, variant: row.variant,
    title: row.title, baseVersion: row.base_version, models: row.models } : null;
}

async function currentModelConfig(pool) {
  const { rows } = await pool.query('SELECT id,source_version,variant,title,base_version,models FROM media_service_model_configs WHERE is_current');
  return mapConfig(rows[0]);
}

async function modelConfigById(pool, id) {
  const { rows } = await pool.query('SELECT id,source_version,variant,title,base_version,models FROM media_service_model_configs WHERE id=$1', [id]);
  return mapConfig(rows[0]);
}

async function saveModelConfig(pool, config) {
  if (!config?.version || !Array.isArray(config.models) || !config.models.length)
    throw new Error('Некорректная конфигурация моделей');
  const variant = config.variant || 'all';
  if (!['all', 'shared'].includes(variant)) throw new Error('Неизвестная версия списка моделей');
  if (variant === 'shared' && config.models.some(row => !row.kie || !row.apimart))
    throw new Error(`В версии «${titles.shared}» допустимы только модели обоих провайдеров`);
  const title = titles[variant];
  const id = `${variant === 'shared' ? 'shared' : 'snapshot'}-${config.version}`;
  const models = JSON.stringify(config.models);
  const existing = await pool.query('SELECT models=$2::jsonb AND variant=$3 AS same FROM media_service_model_configs WHERE id=$1', [id, models, variant]);
  if (existing.rows.length && !existing.rows[0].same) throw new Error('Версия конфигурации моделей уже занята другим содержимым');
  if (!existing.rows.length) await pool.query(`INSERT INTO media_service_model_configs
    (id,source_version,models,variant,title,base_version) VALUES($1,$2,$3::jsonb,$4,$5,$6)`,
    [id, config.version, models, variant, title, config.baseVersion || null]);
  return id;
}

async function listModelConfigs(pool) {
  const { rows } = await pool.query(`SELECT id,source_version,variant,title,base_version,is_current,
    jsonb_array_length(models) AS model_count FROM media_service_model_configs ORDER BY created_at,id`);
  return rows.map(row => ({ id: row.id, version: row.source_version, variant: row.variant, title: row.title,
    baseVersion: row.base_version, isCurrent: row.is_current, modelCount: row.model_count }));
}

async function activateModelConfig(pool, id) {
  return transaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock(18274692)');
    const target = await client.query('SELECT id FROM media_service_model_configs WHERE id=$1', [id]);
    if (!target.rows.length) throw new Error('Конфигурация моделей не найдена');
    await client.query('UPDATE media_service_model_configs SET is_current=false WHERE is_current');
    await client.query('UPDATE media_service_model_configs SET is_current=true,activated_at=now() WHERE id=$1', [id]);
  });
}

module.exports = { ensureCurrentModelConfig, currentModelConfig, modelConfigById, saveModelConfig, listModelConfigs, activateModelConfig };
