const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRouterAiClient } = require('../src/providers/routerai/client');
const { createRouterAiCatalog } = require('../src/providers/routerai/catalog');
const { createRouterAiBilling } = require('../src/services/routerai-billing');
const { openDatabase } = require('../src/database/database');
const { testPool } = require('./helpers/pg-pool');
const { createWallet } = require('../src/billing/wallet');
const { createPricing } = require('../src/billing/pricing');
const { randomUUID } = require('node:crypto');
const catalog = require('../config/routerai-models.json');
const prices = require('../config/native-prices.json');

test('Every offered RouterAI model has the published four-credit price', () => {
  assert.equal(catalog.models.filter(model => model.kind === 'image').length, 4);
  for (const model of catalog.models) assert.equal(prices.models[`routerai:${model.id}`]?.baseUnits, 4000);
});

test('RouterAI exposes the full provider catalog only to admins', async () => {
  const data = [
    { id: 'openai/gpt-oss-20b', name: 'GPT OSS', architecture: { output_modalities: ['text'] } },
    { id: 'google/gemini-image', name: 'Gemini Image', architecture: { output_modalities: ['image', 'text'] } },
    { id: 'maker/video-1', name: 'Video', architecture: { output_modalities: ['video'] } },
    { id: '~openai/gpt-latest', name: 'Latest', architecture: { output_modalities: ['text'] } },
  ];
  const models = createRouterAiCatalog({ fetchImpl: async () => ({ ok: true, json: async () => ({ data }) }) });
  assert.equal((await models.list('user')).models.length, catalog.models.length);
  assert.equal((await models.list('admin')).models.some(model => model.id === 'maker/video-1'), true);
  assert.equal((await models.all('admin')).models.find(model => model.id === 'google/gemini-image').endpoint, 'chat/completions');
  assert.equal((await models.all('admin')).models.find(model => model.id === '~openai/gpt-latest').kind, 'text');
  await assert.rejects(models.all('user'), error => error.status === 403);
});

test('RouterAI sends chat and image requests to documented endpoints', async () => {
  const requests = [];
  const client = createRouterAiClient({ apiKey: 'test-key', fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ data: [] }) };
  } });
  await client.chatCompletion({ model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'Привет' }] });
  await client.generateImage({ model: 'openai/gpt-image-1', prompt: 'Кот' });
  assert.deepEqual(requests.map(item => item.url), [
    'https://routerai.ru/api/v1/chat/completions', 'https://routerai.ru/api/v1/images',
  ]);
  assert.equal(requests[0].options.headers.Authorization, 'Bearer test-key');
  assert.equal(JSON.parse(requests[1].options.body).prompt, 'Кот');
});

test('RouterAI errors never expose response body or key', async () => {
  const client = createRouterAiClient({ apiKey: 'test-key', fetchImpl: async () => ({ ok: false, status: 402, text: async () => 'secret response' }) });
  await assert.rejects(client.generateImage({ model: 'model', prompt: 'prompt' }), error =>
    error.status === 402 && !error.message.includes('secret response') && !error.message.includes('test-key'));
});

test('Only admin catalog models use the four-credit fallback tariff', () => {
  const pricing = createPricing({ version: 'test', models: { 'routerai:admin-catalog': { baseUnits: 4000 } } });
  const billing = createRouterAiBilling({ accounts: { pricing }, apiKey: 'test-key', content: {} });
  assert.equal(billing.quote({ model: 'maker/video-1' }, 'admin').credits, 4);
  assert.throws(() => billing.quote({ model: 'maker/video-1' }, 'user'));
});

test('Admin API request reserves once and saves the provider response', async t => {
  const pool = await openDatabase({}, testPool());
  t.after(() => pool.end());
  const account = randomUUID(), requestId = randomUUID();
  await pool.query("INSERT INTO media_accounts(id,display_name) VALUES($1,'Admin')", [account]);
  await pool.query('INSERT INTO media_wallets(account_id,balance) VALUES($1,8000)', [account]);
  let sent = 0;
  const billing = createRouterAiBilling({ accounts: { pool, pricing: createPricing({ version: 'test', models: { 'routerai:admin-catalog': { baseUnits: 4000 } } }) }, apiKey: 'test-key', content: {},
    fetchImpl: async (_url, options) => { sent++; assert.equal(JSON.parse(options.body).model, 'maker/embedding-1');
      return { ok: true, headers: new Map([['content-type', 'application/json']]), json: async () => ({ data: [{ embedding: [1, 2, 3] }] }) }; } });
  const input = { requestId, model: 'maker/embedding-1', payload: { input: 'Тест' } };
  const allowed = [{ id: 'maker/embedding-1', name: 'Embedding', kind: 'embeddings', endpoint: 'embeddings' }];
  await Promise.all([billing.submitAdmin(account, input, allowed), billing.submitAdmin(account, input, allowed)]);
  let job;
  for (let i = 0; i < 100; i++) { job = await billing.get(account, requestId); if (job.state !== 'running') break; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(job.state, 'success');
  assert.match(job.output, /embedding/);
  assert.equal(sent, 1);
  const wallet = createWallet(pool);
  assert.equal((await wallet.get(account)).balanceUnits, 4000);
});

test('Admin video request polls RouterAI and saves the completed file', async t => {
  const pool = await openDatabase({}, testPool());
  t.after(() => pool.end());
  const account = randomUUID(), requestId = randomUUID(), assetId = randomUUID();
  await pool.query("INSERT INTO media_accounts(id,display_name) VALUES($1,'Admin video')", [account]);
  await pool.query('INSERT INTO media_wallets(account_id,balance) VALUES($1,8000)', [account]);
  const calls = [];
  const billing = createRouterAiBilling({ accounts: { pool, pricing: createPricing({ version: 'test', models: { 'routerai:admin-catalog': { baseUnits: 4000 } } }) }, apiKey: 'test-key',
    content: { createFromBuffer: async (_account, file) => { assert.equal(file.type, 'video/mp4'); return { id: assetId }; }, link: async () => {} },
    fetchImpl: async (url, options) => {
      calls.push(url);
      if (options.method === 'POST') return { ok: true, headers: new Map([['content-type', 'application/json']]), json: async () => ({ id: 'provider-video' }) };
      if (url.endsWith('/content')) return { ok: true, arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer };
      return { ok: true, json: async () => ({ status: 'completed' }) };
    } });
  await billing.submitAdmin(account, { requestId, model: 'maker/video-1', payload: { prompt: 'Тест' } }, [{ id: 'maker/video-1', name: 'Video', kind: 'video', endpoint: 'videos' }]);
  let job;
  for (let i = 0; i < 100; i++) { job = await billing.get(account, requestId); if (job.state !== 'running') break; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(job.state, 'success');
  assert.equal(job.contentAssetId, assetId);
  assert.equal(job.providerVideoId, 'provider-video');
  assert.equal(calls.length, 3);
});

test('RouterAI reserves once, captures success, refunds rejection and holds uncertain outcomes', async t => {
  const pool = await openDatabase({}, testPool());
  t.after(() => pool.end());
  const account = randomUUID();
  await pool.query("INSERT INTO media_accounts(id,display_name) VALUES($1,'Test')", [account]);
  await pool.query('INSERT INTO media_wallets(account_id,balance) VALUES($1,16000)', [account]);
  const wallet = createWallet(pool);
  const pricing = createPricing({ version: 'test', models: { 'routerai:openai/gpt-oss-20b': { baseUnits: 4000 } } });
  let mode = 'success', sent = 0;
  const billing = createRouterAiBilling({ accounts: { pool, wallet, pricing }, apiKey: 'test-key', content: {},
    fetchImpl: async () => {
      sent++;
      if (mode === 'network') throw new Error('network');
      if (mode === 'reject') return { ok: false, status: 402 };
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'Ответ' } }], usage: { total_tokens: 3 } }) };
    } });
  const wait = async id => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const job = await billing.get(account, id);
      if (job.state !== 'running') return job;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('RouterAI job did not finish');
  };
  const request = () => ({ requestId: randomUUID(), model: 'openai/gpt-oss-20b', prompt: 'Привет' });
  const first = request();
  await Promise.all([billing.submit(account, first), billing.submit(account, first)]);
  assert.equal((await wait(first.requestId)).state, 'success');
  assert.equal(sent, 1);
  assert.equal((await wallet.get(account)).balanceUnits, 12000);
  mode = 'reject';
  const rejected = request(); await billing.submit(account, rejected);
  assert.equal((await wait(rejected.requestId)).state, 'fail');
  assert.equal((await wallet.get(account)).balanceUnits, 12000);
  mode = 'network';
  const uncertain = request(); await billing.submit(account, uncertain);
  assert.equal((await wait(uncertain.requestId)).state, 'unknown');
  assert.equal((await wallet.get(account)).heldUnits, 4000);
  assert.equal((await wallet.get(account)).balanceUnits, 12000);
});
