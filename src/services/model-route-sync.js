const { normalizeRows, validateDocument, managedVersion } = require('./model-route-document');
const { transaction } = require('../database/database');
const { modelCandidates } = require('../billing/kie-tariff-resolver');
const { Tariffs } = require('../tariffs');
const { models: kieModels } = require('../catalog');
const fallback = require('../../config/kie-price-fallbacks.json');
const { createApimartClient } = require('../providers/apimart/client');
const { describeModel } = require('../providers/apimart/catalog');
const { simpleRates, publishedMediaTariff } = require('../providers/apimart/pricing');
const systemErrors = require('../system-errors');

const hasPrice = value => typeof value === 'string' && Boolean(value.trim()) && value.trim() !== '—';
const managed = document => Boolean(managedVersion(document.version));

function publishedKieTariff(model, tariffs) {
  const rows = modelCandidates(model, tariffs.rows || []).filter(row =>
    Number.isFinite(Number(row.creditPrice)) && Number(row.creditPrice) > 0 && row.creditUnit);
  if (rows.length) return [...new Set(rows.map(row =>
    `${row.modelDescription}: ${row.creditPrice} кредитов / ${row.creditUnit}`))].join('\n');
  const variants = fallback.models[model.apiModel];
  return variants ? variants.map(row => `${row.resolution}, ${row.duration} с: ${row.amountUnits / 1000} кредитов / видео`).join('\n') : '';
}

// Append independent provider identities; matching display names never creates
// an unverified cross-provider route. Existing IDs, actions and prices win.
function reconcileModelRoutes(document, catalogues) {
  const models = structuredClone(normalizeRows(document.models));
  for (const { provider, models: catalogue, prices } of catalogues) {
    for (const model of catalogue) {
      const providerId = model.id;
      const matches = models.filter(row => row.providers[provider] === providerId);
      const price = prices.get(providerId);
      if (matches.length) {
        for (const row of matches) if (!hasPrice(row.publishedTariffs[provider]) && hasPrice(price))
          row.publishedTariffs[provider] = price;
        continue;
      }
      const row = normalizeRows([{ providers: { [provider]: providerId }, name: model.name,
        kind: model.kind, publishedTariffs: { [provider]: hasPrice(price) ? price : '' } }])[0];
      if (models.some(existing => existing.id === row.id)) row.id = `${provider}.${row.id}`;
      models.push(row);
    }
  }
  // Correct only this exact known imported label; keep user-renamed rows.
  for (const row of models) if (row.providers.kie === 'kie:qwen2/image-edit' && row.name === 'Qwen2 - Text To Image')
    row.name = 'Qwen2 Image Edit';
  return validateDocument({ version: document.version, models });
}

async function mapConcurrent(values, operation, concurrency = 4) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) await operation(values[cursor++]);
  }));
}

function createModelRouteSynchronizer({ pool, fetcher = fetch, apiKey, now = Date.now,
  ttlMs = 10 * 60 * 1000, loadCatalogues } = {}) {
  let pending, expiresAt = 0;
  const tariffs = new Tariffs({ get: async () => null, update: async () => {} }, fetcher);
  const client = apiKey ? createApimartClient({ apiKey, fetchImpl: fetcher }) : null;
  async function collect(document) {
    if (loadCatalogues) return loadCatalogues(document);
    const catalogues = [];
    const results = await Promise.allSettled([
      (async () => {
        const data = await tariffs.get();
        if (data.stale || !data.rows?.length) throw new Error('Fresh Kie tariffs unavailable');
        catalogues.push({ provider: 'kie', models: kieModels,
          prices: new Map(kieModels.map(model => [model.id, publishedKieTariff(model, data)])) });
      })(),
      (async () => {
        if (!client) return;
        const response = await client.models();
        if (!Array.isArray(response.data)) throw new Error('Invalid APIMart catalogue');
        const models = response.data.map(describeModel).filter(Boolean), prices = new Map();
        const needed = models.filter(model => !document.models.some(row =>
          row.providers.apimart === model.id && hasPrice(row.publishedTariffs.apimart)));
        await mapConcurrent(needed, async model => {
          try {
            const payload = await client.pricing(model.id);
            const rates = model.kind === 'text' ? simpleRates(payload) : null;
            const price = rates ? `Вход: $${rates.input} / млн токенов\nВыход: $${rates.output} / млн токенов`
              : publishedMediaTariff(payload, model);
            if (hasPrice(price)) prices.set(model.id, price);
          } catch (error) { systemErrors.record('catalog', 'catalog.apimart.price.failed', error); }
        });
        catalogues.push({ provider: 'apimart', models, prices });
      })(),
    ]);
    for (const result of results) if (result.status === 'rejected')
      systemErrors.record('catalog', 'catalog.refresh.failed', result.reason);
    return catalogues;
  }
  async function refresh(document, { force = false } = {}) {
    if (!managed(document)) return document;
    if (pending) return pending;
    if (!force && now() < expiresAt) return document;
    pending = (async () => {
      const catalogues = await collect(document);
      let result = reconcileModelRoutes(document, catalogues);
      if (pool) result = await transaction(pool, async db => {
        await db.query('SELECT pg_advisory_xact_lock(18274692)');
        const stored = (await db.query('SELECT source_version,models FROM media_model_routes WHERE id=$1', ['model-routes'])).rows[0];
        if (!stored) throw new Error('Model registry is missing');
        const current = { version: stored.source_version, models: stored.models };
        if (!managed(current)) return current;
        const next = reconcileModelRoutes(current, catalogues);
        if (JSON.stringify(next.models) !== JSON.stringify(current.models))
          await db.query('UPDATE media_model_routes SET models=$1::jsonb,updated_at=now() WHERE id=$2', [JSON.stringify(next.models), 'model-routes']);
        return next;
      });
      expiresAt = now() + ttlMs;
      return result;
    })();
    try { return await pending; } finally { pending = null; }
  }
  return refresh;
}
module.exports = { createModelRouteSynchronizer, reconcileModelRoutes, publishedKieTariff, hasPrice };
