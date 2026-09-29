// Read-only catalog audit. Never uploads files or creates paid generations.
const fs = require('node:fs/promises');
const path = require('node:path');
const { models } = require('../src/catalog');
const { Tariffs } = require('../src/tariffs');
const { quoteKie } = require('../src/billing/kie-pricing');
const { plan } = require('../src/price-audit');
const { createApimartJobs } = require('../src/services/apimart-jobs');

async function main() {
  const results = [];
  const tariffs = await new Tariffs({ get: async () => null, update: async () => {} }).get(true);
  if (tariffs.stale || !tariffs.rows.length) throw new Error('Fresh Kie tariffs unavailable');
  const byId = new Map(models.map(model => [model.id, model]));
  for (const item of plan(models)) {
    try {
      const quote = quoteKie(byId.get(item.modelId), item.input, tariffs);
      results.push({ provider: 'kie', model: item.modelId, input: item.input, priced: quote.credits > 0, credits: quote.credits });
    } catch (error) {
      results.push({ provider: 'kie', model: item.modelId, input: item.input, priced: false, reason: error.message });
    }
  }
  const service = createApimartJobs({ pool: null, apiKey: process.env.APIMART_API_KEY });
  const catalog = await service.models();
  let cursor = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < catalog.length) {
      const model = catalog[cursor++];
      const baseline = Object.fromEntries(model.fields.flatMap(field => field.apiDefault != null
        ? [[field.key, field.apiDefault]] : []));
      const cases = [baseline];
      for (const field of model.fields) {
        if (/^(resolution|quality|duration|mode|size|n)$/.test(field.key))
          for (const value of field.options || []) cases.push({ ...baseline, [field.key]: value });
      }
      if (model.fields.some(field => field.key === 'layer_decomposition')) {
        for (const size of ['auto', '1K', '1.5K', '2K']) cases.push({ ...baseline,
          layer_decomposition: true, size, image_urls: ['content:55555555-5555-4555-8555-555555555555'] });
      }
      for (const parameters of cases) {
        try {
          const quote = await service.quote({ model: model.id, prompt: 'A tree', parameters });
          results.push({ provider: 'apimart', model: model.id, input: parameters,
            priced: quote.status === 'estimated' && quote.amountUsd > 0, amountUsd: quote.amountUsd, reason: quote.message || quote.reason });
        } catch (error) {
          results.push({ provider: 'apimart', model: model.id, input: parameters, priced: false, reason: error.message });
        }
      }
    }
  }));
  const summary = Object.fromEntries(['kie', 'apimart'].map(provider => {
    const items = results.filter(item => item.provider === provider);
    const failures = {};
    for (const item of items.filter(item => !item.priced)) failures[item.reason || 'zero_price'] = (failures[item.reason || 'zero_price'] || 0) + 1;
    return [provider, { models: new Set(items.map(item => item.model)).size, cases: items.length,
      priced: items.filter(item => item.priced).length, unpriced: items.filter(item => !item.priced).length, failures }];
  }));
  const output = path.resolve(process.env.MEDIA_DATA_DIR || 'data/service', 'diagnostics/provider-quotes.json');
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify({ checkedAt: new Date().toISOString(), summary, results }, null, 2));
  console.log(JSON.stringify({ summary, report: output }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
