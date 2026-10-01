const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const document = require('../config/model-routes.json');
const { publicRows, validateDocument } = require('../src/services/model-route-document');
const { testPool } = require('./helpers/pg-pool');
const { openDatabase, transaction } = require('../src/database/database');
const { ensureCurrentModelConfig, currentModelConfig, saveModelConfig, listModelConfigs, modelConfigById, readRouteDocument } = require('../src/services/service-model-configs');
const { loadConfig } = require('../src/server/config');
const { createHttpServer } = require('../src/server/http');
const kie = require('../src/catalog').models;
const table = publicRows(document.models).filter(row => Object.values(row.publishedTariffs).some(price => price && price !== '—'));

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


test('one model registry has unique project IDs and covers all former provider IDs', () => {
  validateDocument(document);
  const previous = require('../config/service-model-candidates.json').models;
  for (const provider of ['kie', 'apimart']) {
    const known = new Set(document.models.map(row => row.providers[provider]).filter(Boolean));
    for (const row of previous) if (row[provider]) assert.ok(known.has(row[provider]), row[provider]);
  }
  assert.equal(document.models.find(row => row.id === 'grok-imagine.image-to-image').providers.apimart, 'grok-imagine-1.0-edit-apimart');
  assert.equal(document.models.find(row => row.id === 'gpt-image-2.text-to-image').providers.apimart, 'gpt-image-2');
  assert.equal(document.models.find(row => row.id === 'gpt-image-2.image-to-image').providers.apimart, 'gpt-image-2');
  const groups = new Map();
  for (const row of document.models) {
    assert.ok(row.action);
    if (!row.providers.apimart) continue;
    const rows = groups.get(row.providers.apimart) || [];
    rows.push(row); groups.set(row.providers.apimart, rows);
  }
  for (const rows of groups.values()) if (rows.length > 1)
    assert.equal(new Set(rows.map(row => row.action)).size, rows.length, rows[0].providers.apimart);
});

test('automatic picker emits project IDs and preserves different actions of the same APIMart model', () => {
  const { autoModelOptions, publishedTariffForRoute } = loadAutoModels();
  const apimart = [...new Map(table.filter(row => row.apimart).map(row => [row.apimart, {id:row.apimart,name:row.apimart,kind:row.kind}])).values()];
  const options = ['text','image','video','audio'].flatMap(mode => autoModelOptions(kie, apimart, mode, '', table, true));
  const availableRows = table.filter(row => kie.some(model => model.id === row.kie && model.kind === row.kind)
    && row.kiePrice && row.kiePrice !== '—' || apimart.some(model => model.id === row.apimart && model.kind === row.kind)
    && row.apimartPrice && row.apimartPrice !== '—');
  assert.deepEqual(options.map(option => option.value).sort(), availableRows.map(row => row.id).sort());
  assert.equal(new Set(options.map(option => option.value)).size, options.length);
  assert.ok(options.some(option => option.value === 'gpt-image-2.text-to-image'));
  assert.ok(options.some(option => option.value === 'gpt-image-2.image-to-image'));
  for(const row of table) for(const provider of ['kie','apimart'])
    if(row[provider]) assert.equal(publishedTariffForRoute(row.id,provider,row[provider],table),row.publishedTariffs[provider] === '—' ? '' : row.publishedTariffs[provider] || '');
});

test('automatic picker hides unavailable routes in every mode and keeps priced provider fallbacks', () => {
  const { autoModelOptions } = loadAutoModels();
  for (const kind of ['text', 'image', 'video', 'audio']) {
    const row = (id, providers, publishedTariffs) => publicRows([{ id, name: id, kind, action: 'auto', providers, publishedTariffs }])[0];
    const rows = [
      row('missing', { kie: 'kie:missing', apimart: 'missing' }, { kie: '1', apimart: '2' }),
      row('fallback', { kie: 'kie:missing', apimart: 'available' }, { kie: '1', apimart: '2' }),
      row('kie-only', { kie: 'kie:available' }, { kie: '1' }),
      row('unpriced', { kie: 'kie:available', apimart: 'available' }, { kie: '—', apimart: '' }),
      row('wrong-kind', { kie: 'kie:other', apimart: 'other' }, { kie: '1', apimart: '2' }),
    ];
    const otherKind = kind === 'image' ? 'video' : 'image';
    const kieModels = [{ id: 'kie:available', name: 'Available', kind }, { id: 'kie:other', name: 'Other', kind: otherKind }];
    const apimartModels = [{ id: 'available', name: 'Available', kind }, { id: 'other', name: 'Other', kind: otherKind }];
    for (const listedOnly of [true, false]) {
      const options = autoModelOptions(kieModels, apimartModels, kind, 'missing', rows, listedOnly);
      assert.deepEqual(options.map(option => option.value), ['fallback', 'kie-only']);
      assert.ok(options.every(option => !option.disabled));
    }
    assert.deepEqual(autoModelOptions([], [], kind, 'missing', rows, true), []);
  }
});

test('migration retains the richest model snapshot before dropping both legacy tables', async t => {
  const pool=testPool();t.after(()=>pool.end());
  for(const name of ['0017-service-model-configs.sql','0018-service-model-config-variants.sql','0019-parameter-conversion-configs.sql'])
    await pool.query(fs.readFileSync(path.join(__dirname,'../src/database/migrations',name),'utf8'));
  const old=[{kind:'image',kie:'kie:test',apimart:'test',name:'Preserved'}];
  await pool.query('INSERT INTO media_service_model_configs(id,source_version,models,is_current) VALUES($1,$2,$3::jsonb,true)', ['old','old',JSON.stringify(old)]);
  await transaction(pool,db=>db.query(fs.readFileSync(path.join(__dirname,'../src/database/migrations/0020-unified-model-routes.sql'),'utf8')));
  assert.deepEqual((await pool.query('SELECT models FROM media_model_routes')).rows[0].models,old);
  const retired=(await pool.query("SELECT to_regclass('media_service_model_configs') AS models,to_regclass('media_parameter_conversion_configs') AS parameters")).rows[0];
  assert.deepEqual(retired,{models:null,parameters:null});
  await ensureCurrentModelConfig(pool);
  assert.ok((await readRouteDocument(pool)).models.some(row=>row.providers.kie==='kie:test'));
});

test('both picker views read one registry and imports replace it without resurrecting versions', async t => {
  const pool=await openDatabase({},testPool());t.after(()=>pool.end());
  assert.equal(await ensureCurrentModelConfig(pool),'model-routes');
  assert.equal(await ensureCurrentModelConfig(pool),'model-routes');
  const old = structuredClone(document.models);
  old.forEach(row => { row.action = null; });
  await pool.query('UPDATE media_model_routes SET models=$1::jsonb', [JSON.stringify(old)]);
  await ensureCurrentModelConfig(pool);
  assert.ok((await readRouteDocument(pool)).models.every(row => row.action));
  const views=await listModelConfigs(pool);
  assert.equal(views.length,2);
  assert.equal(views[0].version,views[1].version);
  assert.equal((await modelConfigById(pool,'model-routes/shared')).models.every(row=>row.kie&&row.apimart),true);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM media_model_routes')).rows[0].count,1);
  assert.equal(await modelConfigById(pool,'snapshot-old'),null);
  const custom={version:'custom',models:[{providers:{kie:'kie:test',third:'third-test'},publishedTariffs:{kie:'1'},kind:'image',name:'Custom',action:'auto',id:'custom.image'}]};
  await saveModelConfig(pool,custom);
  await ensureCurrentModelConfig(pool);
  assert.deepEqual(await readRouteDocument(pool),custom);
  await assert.rejects(saveModelConfig(pool,{...custom,variant:'shared'}),/полную/);
});

test('model API exposes stable project IDs and two filters of one table', async t => {
  const pool=await openDatabase({},testPool());t.after(()=>pool.end());await ensureCurrentModelConfig(pool);
  const server=createHttpServer({config:loadConfig({MEDIA_PORT:'0',MEDIA_AUTH_ENABLED:'false'}),service:{},accounts:{pool},auth:{user:async()=>({id:'test-user',role:'user'}),providers:()=>[]}});
  t.after(()=>new Promise(resolve=>server.close(resolve)));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+server.address().port;
  const current=await fetch(url+'/api/service-model-config/current').then(r=>r.json());
  assert.equal(current.result.id,'model-routes');
  assert.ok(current.result.models.some(row=>row.id==='gpt-image-2.text-to-image'));
  const list=await fetch(url+'/api/service-model-configs').then(r=>r.json());
  assert.equal(list.result.length,2);
  const shared=await fetch(url+'/api/service-model-config?id=model-routes%2Fshared').then(r=>r.json());
  assert.ok(shared.result.models.every(row=>row.kie&&row.apimart));
});
