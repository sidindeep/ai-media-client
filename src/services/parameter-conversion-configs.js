const seed = require('../../config/parameter-conversions.json');
const compatibility = require('../../config/cost-routing-compatibility.json');
const sharedModels = require('../../config/service-models-v2.json').models;
const { models: kieModels } = require('../catalog');
const apimartModels = require('../../config/apimart-schemas.json').models;
const { transaction } = require('../database/database');

const configId = `routes-${seed.version}`;

function buildSeedDocument() {
  const canonical = seed.canonical;
  const kie = Object.fromEntries(kieModels.map(model => [model.id, {
    kind: model.kind,
    fields: Object.entries(model.inputSchema?.properties || {}).map(([key, schema]) => ({
      key, canonical: canonical[key] || key, required: (model.inputSchema?.required || []).includes(key),
      type: schema.type || null, values: schema.enum || null,
    })),
  }]));
  const apimart = Object.fromEntries(Object.entries(apimartModels).map(([id, model]) => [id, {
    fields: (model.fields || []).map(field => ({ key: field.key, canonical: canonical[field.key] || field.key,
      required: !!field.required, type: field.type || null, values: field.options || null })),
    promptRequired: model.promptRequired !== false,
  }]));
  for (const pair of compatibility.pairs) {
    if (!apimart[pair.apimart]) apimart[pair.apimart] = { fields: [], promptRequired: true, schemaAvailable: false };
  }
  const confirmed = new Set(compatibility.pairs.map(pair => pair.kie));
  const sharedPairs = sharedModels.filter(row => ['image', 'video'].includes(row.kind)
    && kie[row.kie] && apimart[row.apimart] && !confirmed.has(row.kie))
    .map(row => ({ kie: row.kie, apimart: row.apimart, kind: row.kind }));
  const pairs = [...compatibility.pairs, ...sharedPairs].map(pair => {
    const source = kie[pair.kie];
    const target = apimart[pair.apimart];
    const override = seed.pairOverrides[pair.kie] || {};
    const fields = { ...pair.mapping?.fields, ...override.fields };
    for (const field of source?.fields || []) {
      if (field.key === 'prompt' || fields[field.key]) continue;
      const matching = (target?.fields || []).filter(item => item.canonical === field.canonical);
      if (matching.length === 1) fields[field.key] = matching[0].key;
    }
    return { kie: pair.kie, apimart: pair.apimart, kind: pair.kind,
      mapping: { fields, constants: pair.mapping?.constants || {}, values: override.values || {},
        omitWhen: seed.omitWhen } };
  });
  return { version: seed.version, providers: { kie, apimart }, pairs };
}

function validateDocument(document) {
  if (!document || typeof document !== 'object' || !Array.isArray(document.pairs)
    || !document.providers?.kie || !document.providers?.apimart
    || document.pairs.some(pair => !pair.kie || !pair.apimart || !pair.mapping?.fields
      || !document.providers.kie[pair.kie] || !document.providers.apimart[pair.apimart])) {
    throw new Error('Некорректная конфигурация преобразования параметров');
  }
}

async function ensureCurrentParameterConversionConfig(pool) {
  const document = buildSeedDocument();
  validateDocument(document);
  return transaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock(18274693)');
    const current = await client.query('SELECT id FROM media_parameter_conversion_configs WHERE is_current');
    await client.query(`INSERT INTO media_parameter_conversion_configs(id,source_version,document)
      VALUES($1,$2,$3::jsonb) ON CONFLICT(id) DO NOTHING`, [configId, seed.version, JSON.stringify(document)]);
    if (!current.rows.length || seed.replaces?.includes(current.rows[0].id)) {
      await client.query('UPDATE media_parameter_conversion_configs SET is_current=false WHERE is_current');
      await client.query(`UPDATE media_parameter_conversion_configs
        SET is_current=true,activated_at=now() WHERE id=$1`, [configId]);
    }
    return current.rows[0]?.id || configId;
  });
}

async function currentParameterConversionConfig(pool) {
  const { rows } = await pool.query(`SELECT id,source_version,document FROM media_parameter_conversion_configs
    WHERE is_current`);
  if (!rows.length) throw new Error('Активная конфигурация преобразования параметров не найдена');
  validateDocument(rows[0].document);
  return { id: rows[0].id, version: rows[0].source_version, ...rows[0].document };
}

async function saveParameterConversionConfig(pool, version, document) {
  validateDocument(document);
  if (typeof version !== 'string' || !version.trim()) throw new Error('Не указана версия преобразования параметров');
  const id = `routes-${version}`;
  const serialized = JSON.stringify(document);
  const existing = await pool.query('SELECT document=$2::jsonb AS same FROM media_parameter_conversion_configs WHERE id=$1', [id, serialized]);
  if (existing.rows.length && !existing.rows[0].same) throw new Error('Версия преобразования параметров уже занята');
  if (!existing.rows.length) await pool.query(`INSERT INTO media_parameter_conversion_configs(id,source_version,document)
    VALUES($1,$2,$3::jsonb)`, [id, version, serialized]);
  return id;
}

async function activateParameterConversionConfig(pool, id) {
  return transaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock(18274693)');
    const target = await client.query('SELECT id FROM media_parameter_conversion_configs WHERE id=$1', [id]);
    if (!target.rows.length) throw new Error('Конфигурация преобразования параметров не найдена');
    await client.query('UPDATE media_parameter_conversion_configs SET is_current=false WHERE is_current');
    await client.query('UPDATE media_parameter_conversion_configs SET is_current=true,activated_at=now() WHERE id=$1', [id]);
  });
}

module.exports = { buildSeedDocument, ensureCurrentParameterConversionConfig, currentParameterConversionConfig,
  saveParameterConversionConfig, activateParameterConversionConfig };
