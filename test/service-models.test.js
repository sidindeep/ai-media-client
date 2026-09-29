const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const full = require('../config/service-models.json');
const table = full.models;
const candidates = require('../config/service-model-candidates.json').models;
const shared = require('../config/service-models-v2.json');
const kie = require('../src/catalog').models;
const compatibility = require('../config/cost-routing-compatibility.json').pairs;
const kieMarket = require('../config/kie-market-models.json');
const { testPool } = require('./helpers/pg-pool');
const { openDatabase } = require('../src/database/database');
const { ensureCurrentModelConfig, currentModelConfig, saveModelConfig, listModelConfigs, activateModelConfig } = require('../src/services/service-model-configs');
const { loadConfig } = require('../src/server/config');
const { createHttpServer } = require('../src/server/http');

function loadAutoModels() {
  const filename = path.resolve(__dirname, '../web/src/domain/auto-models.ts');
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, esModuleInterop: true, resolveJsonModule: true,
  } }).outputText;
  const compiled = new Module(filename, module);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = compiled.require.bind(compiled);
  compiled.require = id => id === './model-catalog'
    ? { apimartModelBrandId: () => 'apimart', mediaModelBrandId: () => 'kie' }
    : originalRequire(id);
  compiled._compile(output, filename);
  return compiled.exports;
}

test('priced service correspondence derives from the full provider candidates', () => {
  assert.equal(full.title, 'Все модели с ценой');
  assert.equal(full.variant, 'all');
  const kieRows = candidates.filter(row => row.kie);
  assert.ok(kieRows.length >= kie.length);
  for (const model of kie) assert.ok(kieRows.some(row => row.kie === model.id), model.id);
  for (const apiModel of kieMarket.paths) assert.ok(kieRows.some(row => row.kie === `kie:${apiModel}`), apiModel);
  for (const [apimart, kie] of [
    ['claude-opus-4-7', 'kie:claude-opus-4-7'],
    ['deepseek-v4.1-flash', 'kie:deepseek-v4-1-flash'],
    ['gemini-3.8-flash', 'kie:gemini-3-8-flash'],
    ['gpt-5.4', 'kie:gpt-5-4'],
  ]) assert.ok(candidates.some(row => row.apimart === apimart && row.kie === kie), `${apimart} ↔ ${kie}`);
  for (const pair of compatibility) {
    assert.ok(candidates.some(row => row.kie === pair.kie && row.apimart === pair.apimart), pair.kie);
  }
  const hasPrice = value => Boolean(value && value !== '—');
  assert.deepEqual(table, candidates.filter(row => hasPrice(row.apimartPrice) || hasPrice(row.kiePrice)));
  assert.ok(!table.some(row => row.kie === 'kie:bytedance/seedream'), 'unpriced Seedream 3.0 is excluded');
  const names = table.map(row => `${row.kind}:${row.name.toLocaleLowerCase()}`);
  assert.equal(new Set(names).size, names.length, 'service names must be distinct within a mode');
});

test('automatic picker uses priced service rows and keeps unmatched priced APIMart models', () => {
  const { autoModelOptions, serviceNameForApimart } = loadAutoModels();
  const apimart = [...new Map(table.filter(row => row.apimart).map(row => [row.apimart,
    { id: row.apimart, name: row.apimart, kind: row.kind }])).values()];
  const options = ['text', 'image', 'video', 'audio'].flatMap(mode => autoModelOptions(kie, apimart, mode, '', table, true));
  assert.equal(options.length, table.length, 'all priced catalog rows remain visible');
  assert.equal(new Set(options.map(option => option.value)).size, options.length);
  assert.deepEqual(options.filter(option => option.label.startsWith('Seedream 4.0')).map(option => option.label).sort(),
    ['Seedream 4.0 - Edit', 'Seedream 4.0 - Text to Image']);
  assert.ok(options.some(option => option.value === 'apimart:seedream-5-0-flash'));
  assert.ok(!options.some(option => option.value === 'kie:bytedance/seedream'));
  assert.equal(serviceNameForApimart('seedream-4-0', table), 'Seedream 4.0');
  const apimartLabels = apimart.map(model => `${model.kind}:${serviceNameForApimart(model.id, table)}`.toLocaleLowerCase());
  assert.equal(new Set(apimartLabels).size, apimartLabels.length,
    'manual APIMart choices need distinct service names within a mode');
});

test('second service catalog contains exactly the models available in both provider catalogs', () => {
  assert.equal(shared.variant, 'shared');
  assert.equal(shared.title, 'Модели с ID Kie и APIMart');
  assert.equal(shared.baseVersion, require('../config/service-models.json').version);
  assert.deepEqual(shared.models, table.filter(row => row.apimart && row.kie));
  const { autoModelOptions } = loadAutoModels();
  const apimart = [...new Map(table.filter(row => row.apimart).map(row => [row.apimart,
    { id: row.apimart, name: row.apimart, kind: row.kind }])).values()];
  const options = ['text', 'image', 'video', 'audio'].flatMap(mode => autoModelOptions(kie, apimart, mode, '', shared.models, true));
  assert.equal(options.length, shared.models.length);
  assert.ok(options.every(option => shared.models.some(row => row.kie === option.value || `apimart:${row.apimart}` === option.value)));
});

test('route comparison can show every published provider tariff in the priced catalog', () => {
  const { publishedTariffForRoute } = loadAutoModels();
  let pricedPairs = 0;
  for (const row of table) {
    const selected = row.kie || `apimart:${row.apimart}`;
    if (row.kiePrice && row.kiePrice !== '—')
      assert.equal(publishedTariffForRoute(selected, 'kie', row.kie, table), row.kiePrice, row.name);
    if (row.apimartPrice && row.apimartPrice !== '—')
      assert.equal(publishedTariffForRoute(selected, 'apimart', row.apimart, table), row.apimartPrice, row.name);
    if (row.kie && row.apimartPrice && row.apimartPrice !== '—')
      assert.equal(publishedTariffForRoute(row.kie, 'apimart', '', table), row.apimartPrice, row.name);
    if (row.kiePrice && row.kiePrice !== '—' && row.apimartPrice && row.apimartPrice !== '—') pricedPairs++;
  }
  assert.ok(pricedPairs > 0, 'the catalog must contain models with both published tariffs');
});

test('model correspondence configurations persist with one active version', async t => {
  const pool = await openDatabase({}, testPool());
  t.after(() => pool.end());
  const firstId = await ensureCurrentModelConfig(pool);
  assert.equal(await ensureCurrentModelConfig(pool), firstId);
  const first = await currentModelConfig(pool);
  assert.equal(first.id, firstId);
  assert.deepEqual(first.models, shared.models);
  assert.equal(first.title, shared.title);
  const seededShared = (await listModelConfigs(pool)).find(item => item.variant === 'shared');
  assert.equal(seededShared?.modelCount, shared.models.length);
  assert.equal(seededShared?.isCurrent, true);
  assert.equal(seededShared?.title, shared.title);
  assert.equal((await listModelConfigs(pool)).find(item => item.variant === 'all')?.title, full.title);
  assert.equal((await listModelConfigs(pool)).find(item => item.variant === 'all')?.isCurrent, false);
  await pool.query('INSERT INTO media_service_model_configs(id,source_version,models) VALUES($1,$2,$3::jsonb)',
    ['alternate', 'test', JSON.stringify([{ kind: 'image', apimart: null, kie: 'test', name: 'Test model' }])]);
  await assert.rejects(pool.query("UPDATE media_service_model_configs SET is_current=true WHERE id='alternate'"),
    { code: '23505' });
  await activateModelConfig(pool, 'alternate');
  assert.deepEqual((await currentModelConfig(pool)).models.map(row => row.name), ['Test model']);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM media_service_model_configs WHERE is_current')).rows[0].count, 1);
  await ensureCurrentModelConfig(pool);
  assert.equal((await currentModelConfig(pool)).id, 'alternate');
  assert.equal((await currentModelConfig(pool)).title, full.title);
  const snapshotId = await saveModelConfig(pool, { version: 'test-snapshot', models: table });
  await activateModelConfig(pool, snapshotId);
  assert.deepEqual((await currentModelConfig(pool)).models, table);
  const sharedId = await saveModelConfig(pool, shared);
  assert.equal((await currentModelConfig(pool)).id, snapshotId, 'saving the second version does not change the current version');
  const configs = await listModelConfigs(pool);
  assert.equal(configs.find(item => item.id === snapshotId)?.title, full.title);
  assert.equal(configs.find(item => item.id === sharedId)?.title, shared.title);
  assert.equal(configs.find(item => item.id === sharedId)?.modelCount, shared.models.length);
  assert.equal(configs.find(item => item.id === sharedId)?.isCurrent, false);
  await activateModelConfig(pool, sharedId);
  assert.equal((await currentModelConfig(pool)).variant, 'shared');
  assert.deepEqual((await currentModelConfig(pool)).models, shared.models);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM media_service_model_configs WHERE is_current')).rows[0].count, 1);
});

test('authenticated API returns the active model configuration', async t => {
  const pool = await openDatabase({}, testPool());
  t.after(() => pool.end());
  await ensureCurrentModelConfig(pool);
  const server = createHttpServer({ config: loadConfig({ MEDIA_PORT: '0', MEDIA_AUTH_ENABLED: 'false' }),
    service: {}, accounts: { pool }, auth: { user: async () => ({ id: 'test-user', role: 'user' }), providers: () => [] } });
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/service-model-config/current`);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).result.models, shared.models);
  const sharedId = await saveModelConfig(pool, shared);
  const list = await fetch(`http://127.0.0.1:${server.address().port}/api/service-model-configs`).then(r => r.json());
  assert.equal(list.result.find(item => item.id === sharedId)?.modelCount, shared.models.length);
  const selected = await fetch(`http://127.0.0.1:${server.address().port}/api/service-model-config?id=${encodeURIComponent(sharedId)}`).then(r => r.json());
  assert.deepEqual(selected.result.models, shared.models);
});
