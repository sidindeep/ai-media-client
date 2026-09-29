const test = require('node:test');
const assert = require('node:assert/strict');
const { createApimartClient } = require('../src/providers/apimart/client');
const { createApimartJobs } = require('../src/services/apimart-jobs');
const { defineProvider } = require('../src/providers/contract');
const { simpleRates, estimate, usedCost, mediaEstimate } = require('../src/providers/apimart/pricing');
const { readProviderStatus } = require('../src/services/provider-status');
const { describeModel } = require('../src/providers/apimart/catalog');
const { openDatabase } = require('../src/database/database');
const { testPool } = require('./helpers/pg-pool');
const { randomUUID } = require('node:crypto');

const billingStub = { lockWallet: async () => ({ balance: 100000, held: 0 }), reserve: async () => {},
  increaseReservation: async () => {}, settle: async () => {} };

test('APIMart provider status reports account credits rather than token quota', async () => {
  const pool = {};
  const apiKey = 'private-test-key';
  let requestedUrl;
  const service = createApimartJobs({ pool, apiKey, fetchImpl: async url => {
    requestedUrl = url;
    return { ok: true, json: async () => ({ success: true, remain_balance: 1.25, remain_credits: 12.5 }) };
  } });
  const status = await readProviderStatus({ provider: 'apimart', apimart: service.provider.getStatus });
  assert.equal(status.balance.amount, 12.5);
  assert.match(requestedUrl, /\/v1\/user\/balance$/);
  assert.equal('unlimited' in status, false);
});

test('APIMart quote keeps provider credits and USD separate', () => {
  const rates = simpleRates({ data: { pricing: { unit: 'usd_per_million_tokens', tier_count: 1,
    effective_rates: { input: 0.12, output: 0.48 } } } });
  assert.deepEqual(rates, { input: 0.12, output: 0.48 });
  const quoted = estimate(rates, 'hello');
  assert.equal(quoted.estimatedOutputTokens, 512);
  assert.equal(quoted.inputUsdPerToken, 0.00000012);
  assert.equal(quoted.outputUsdPerToken, 0.00000048);
  assert.ok(Math.abs(quoted.amountUsd - (quoted.estimatedInputTokens * quoted.inputUsdPerToken
    + quoted.estimatedOutputTokens * quoted.outputUsdPerToken)) < 1e-12);
  assert.equal(quoted.nativeCredits, quoted.amountUsd * 10);
  assert.deepEqual(usedCost(rates, { prompt_tokens: 100, completion_tokens: 200 }),
    { amountUsd: 0.000108, nativeCredits: 0.00108 });
  assert.equal(usedCost(rates, { prompt_tokens: 100, completion_tokens: 200,
    prompt_tokens_details: { cached_tokens: 50 } }), null);
  assert.equal(simpleRates({ data: { pricing: { unit: 'usd_per_million_tokens', tier_count: 2,
    effective_rates: { input: 1, output: 2 } } } }), null);
});

test('application provider contract distinguishes external billing from free usage', async () => {
  assert.throws(() => defineProvider({ id: 'broken', name: 'Broken', kinds: ['text'], billing: { mode: 'external' } }), TypeError);
  const provider = defineProvider({ id: 'sample', name: 'Sample', kinds: ['text'], billing: { mode: 'external', unit: null },
    listModels: async () => [], quote: async () => ({ status: 'external', credits: null }),
    submit: async () => ({}), getTask: async () => ({}), getStatus: async () => ({ configured: true, balance: null }) });
  assert.equal(provider.billing.mode, 'external');
  assert.deepEqual(await provider.quote(), { status: 'external', credits: null });
  assert.ok(Object.isFrozen(provider));
});

test('APIMart groups catalog models and never sends the same accepted request twice', async () => {
  const account = '11111111-1111-4111-8111-111111111111';
  const requestId = '22222222-2222-4222-8222-222222222222';
  const jobs = new Map();
  const requests = [];
  let finished;
  const completed = new Promise(resolve => { finished = resolve; });
  const query = async (sql, params = []) => {
    if (sql.startsWith('SELECT data FROM media_records')) return { rows: jobs.has(params[1]) ? [{ data: jobs.get(params[1]) }] : [] };
    if (sql.startsWith('INSERT INTO media_records') && sql.includes("'apimart'")) jobs.set(params[1], JSON.parse(params[2]));
    if (sql.startsWith('UPDATE media_records')) { jobs.set(params[1], JSON.parse(params[2])); finished(); }
    return { rows: [] };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  const fetchImpl = async (url, init) => {
    requests.push({ url, body: init?.body });
    return { ok: true, json: async () => url.includes('/pricing/model?') ? { data: { pricing: {
      unit: 'usd_per_million_tokens', tier_count: 1, effective_rates: { input: 0.12, output: 0.48 },
    } } } : url.includes('/models?') ? { data: [
      { id: 'babbage-002', category: 'chat' }, { id: 'davinci-002', category: 'chat' },
      { id: 'gpt-4o', category: 'chat' }, { id: 'gpt-image-2', category: 'image' },
    ] } : { choices: [{ message: { content: 'Готово' } }], usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 } } };
  };
  const jobsService = createApimartJobs({ pool, apiKey: 'private-test-key', fetchImpl, billing: billingStub });
  assert.equal(jobsService.provider.billing.mode, 'wallet');
  const quoted = await jobsService.provider.quote({ model: 'gpt-4o', prompt: 'Привет' });
  assert.equal(quoted.status, 'estimated');
  assert.equal(quoted.credits, Math.ceil(quoted.nativeCredits * 1000 - 1e-9) / 1000);
  assert.equal(quoted.nativeCredits, quoted.amountUsd * 10);
  assert.deepEqual((await jobsService.models()).map(({ id, kind, endpoint }) => ({ id, kind, endpoint })), [
    { id: 'babbage-002', kind: 'text', endpoint: '/v1/completions' },
    { id: 'davinci-002', kind: 'text', endpoint: '/v1/completions' },
    { id: 'gpt-4o', kind: 'text', endpoint: '/v1/chat/completions' },
    { id: 'gpt-image-2', kind: 'image', endpoint: '/v1/images/generations' },
  ]);
  const input = { requestId, model: 'gpt-4o', prompt: 'Привет' };
  const initial = await jobsService.submit(account, input);
  assert.equal(initial.state, 'running');
  await completed;
  assert.equal((await jobsService.get(account, requestId)).output, 'Готово');
  assert.ok((await jobsService.get(account, requestId)).apimartTariffCost.amountUsd > 0);
  assert.equal((await jobsService.submit(account, input)).state, 'success');
  assert.equal(requests.filter(item => item.url.endsWith('/chat/completions')).length, 1);
  assert.equal(JSON.stringify([...jobs.values()]).includes('private-test-key'), false);
  await assert.rejects(() => jobsService.submit(account, { ...input, model: 'other-model' }), { status: 409 });
});

test('APIMart image task uses image endpoint, polls, and reports task credits', async () => {
  const account = '11111111-1111-4111-8111-111111111111';
  const requestId = '33333333-3333-4333-8333-333333333333';
  const jobs = new Map();
  const requests = [];
  const query = async (sql, params = []) => {
    if (sql.startsWith('SELECT data FROM media_records')) return { rows: jobs.has(params[1]) ? [{ data: jobs.get(params[1]) }] : [] };
    if (sql.startsWith('INSERT INTO media_records') && sql.includes("'apimart'")) jobs.set(params[1], JSON.parse(params[2]));
    if (sql.startsWith('UPDATE media_records')) jobs.set(params[1], JSON.parse(params[2]));
    return { rows: [] };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  const fetchImpl = async (url, init) => {
    requests.push({ url, body: init?.body });
    return { ok: true, json: async () => url.includes('/pricing/model?') ? { data: { paid_price: 0.15 } }
      : url.includes('/models?') ? { data: [{ id: 'gpt-image-2', category: 'image', capability_tags: ['Text to Image'] }] }
      : url.endsWith('/images/generations') ? { data: [{ task_id: 'task_example' }] }
        : { data: { status: 'completed', cost: 0.15, credits_cost: 1.5,
          result: { images: [{ url: ['https://example.com/result.png'] }] } } } };
  };
  const service = createApimartJobs({ pool, apiKey: 'private-test-key', fetchImpl, billing: billingStub });
  const input = { requestId, model: 'gpt-image-2', prompt: 'кот', parameters: { resolution: '2k' } };
  await service.submit(account, input);
  for (let i = 0; i < 100 && (await service.get(account, requestId))?.state !== 'success'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  const job = await service.get(account, requestId);
  assert.equal(job.state, 'success');
  assert.equal(job.providerTaskId, 'task_example');
  assert.deepEqual(job.apimartTariffCost, { amountUsd: 0.15, nativeCredits: 1.5, confirmed: true });
  assert.deepEqual(job.resultUrls, ['https://example.com/result.png']);
  assert.equal(requests.filter(item => item.url.endsWith('/images/generations')).length, 1);
  assert.equal(requests.filter(item => item.url.endsWith('/tasks/task_example')).length, 1);
  assert.equal((await service.submit(account, input)).state, 'success');
  assert.equal(requests.filter(item => item.url.endsWith('/images/generations')).length, 1);
});

test('APIMart uploads a selected Seedance image and sends its URL to generation', async () => {
  const account = '11111111-1111-4111-8111-111111111111';
  const requestId = '44444444-4444-4444-8444-444444444444';
  const assetId = '55555555-5555-4555-8555-555555555555';
  const jobs = new Map(), requests = [], links = [];
  const query = async (sql, params = []) => {
    if (sql.startsWith('SELECT data FROM media_records')) return { rows: jobs.has(params[1]) ? [{ data: jobs.get(params[1]) }] : [] };
    if (sql.startsWith('INSERT INTO media_records') && sql.includes("'apimart'")) jobs.set(params[1], JSON.parse(params[2]));
    if (sql.startsWith('UPDATE media_records')) jobs.set(params[1], JSON.parse(params[2]));
    return { rows: [] };
  };
  const content = {
    file: async (owner, id) => { assert.equal(owner, account); assert.equal(id, assetId); return { name: 'reference.png', type: 'image/png' }; },
    read: async () => Buffer.from('image-bytes'),
    link: async (...args) => { links.push(args); },
    createFromUrl: async () => { throw new Error('external result in test'); },
  };
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    const data = url.includes('/pricing/model?') ? { paid_price: 0.22 }
      : url.includes('/models?') ? [{ id: 'seedance-1-5-pro', category: 'video' }]
      : url.endsWith('/uploads/images') ? { url: 'https://upload.apimart.ai/f/image/reference.png' }
        : url.endsWith('/videos/generations') ? [{ task_id: 'video_task' }]
          : { status: 'completed', cost: 0.22, credits_cost: 2.2,
            result: { videos: [{ url: 'https://example.com/video.mp4' }] } };
    return { ok: true, json: async () => url.endsWith('/uploads/images') ? data : { data } };
  };
  const service = createApimartJobs({ pool: { query, connect: async () => ({ query, release() {} }) },
    content, apiKey: 'private-test-key', fetchImpl, billing: billingStub });
  const field = describeModel({ id: 'seedance-1-5-pro', category: 'video' }).fields.find(item => item.key === 'image_urls');
  assert.equal(field.type, 'files');
  assert.equal(field.uploadToApimart, true);
  const input = { requestId, model: 'seedance-1-5-pro', prompt: 'Animate it', parameters: { image_urls: [`content:${assetId}`] } };
  await service.submit(account, input);
  for (let i = 0; i < 100 && (await service.get(account, requestId))?.state !== 'success'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await service.get(account, requestId)).state, 'success');
  const upload = requests.find(item => item.url.endsWith('/uploads/images'));
  assert.ok(upload.init.body instanceof FormData);
  assert.equal(upload.init.body.get('file').name, 'reference.png');
  assert.equal(await upload.init.body.get('file').text(), 'image-bytes');
  const generation = requests.find(item => item.url.endsWith('/videos/generations'));
  assert.deepEqual(JSON.parse(generation.init.body).image_urls, ['https://upload.apimart.ai/f/image/reference.png']);
  assert.ok(links.some(item => item[3] === assetId && item[4] === 'source'));
  await service.submit(account, input);
  assert.equal(requests.filter(item => item.url.endsWith('/uploads/images')).length, 1);
  assert.equal(requests.filter(item => item.url.endsWith('/videos/generations')).length, 1);
});

test('APIMart schemas select the model-specific fields and API before submitting', () => {
  const seedance = describeModel({ id: 'seedance-2.0', category: 'video' });
  assert.ok(seedance.fields.some(field => field.key === 'size'));
  assert.equal(seedance.fields.some(field => field.key === 'role'), false, 'nested reference role is not a required top-level field');
  const kling = describeModel({ id: 'kling-v3', category: 'video' });
  assert.ok(kling.fields.some(field => field.key === 'aspect_ratio'));
  assert.equal(kling.fields.some(field => field.key === 'size'), false);
  assert.equal(describeModel({ id: 'midjourney', category: 'image' }).endpoint, '/v1/midjourney/generations');
  assert.equal(describeModel({ id: 'whisper-1', category: 'audio' }).promptRequired, false);
  assert.equal(describeModel({ id: 'gpt-5-pro', category: 'chat', supported_endpoint_types: ['openai-response'] }).endpoint, '/v1/responses');
  assert.equal(describeModel({ id: 'tts-1', category: 'audio' }).endpoint, '/v1/audio/speech');
  assert.equal(describeModel({ id: 'future-model', category: 'image' }).kind, 'image');
});

test('APIMart Responses and legacy completions use their native request bodies', async () => {
  const calls = [];
  const client = createApimartClient({ apiKey: 'test-key', fetchImpl: async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({}) };
  } });
  await client.text('gpt-5-pro', 'test', '/v1/responses');
  await client.text('babbage-002', 'test', '/v1/completions');
  assert.equal(calls[0].url, 'https://api.apimart.ai/v1/responses');
  assert.equal(calls[0].body.input, 'test');
  assert.equal(calls[1].url, 'https://api.apimart.ai/v1/completions');
  assert.equal(calls[1].body.prompt, 'test');
});

test('APIMart estimates only supported media tariff shapes', () => {
  const model = { id: 'gpt-image-2', kind: 'image' };
  assert.deepEqual(mediaEstimate({ data: { paid_price: 0.01, resolution_paid_prices: { '2K': 0.02 } } }, model,
    { resolution: '2k', n: 2 }), { status: 'estimated', credits: null, amountUsd: 0.04, nativeCredits: 0.4 });
  assert.equal(mediaEstimate({ data: { billing_type: 'per_second' } }, model), null);
  assert.equal(mediaEstimate({ data: { billing_type: 'tiered_token', paid_price: 0.032 } }, model), null);
  const lite = { id: 'gemini-3.1-flash-lite-image', kind: 'image',
    fields: [{ key: 'resolution', apiDefault: '1K' }] };
  const liteTariff = { data: { billing_type: 'tiered_token', paid_price: 0.032,
    pricing: { unit: 'usd_per_million_tokens', pricing_mode: 'image_modalities' } } };
  assert.deepEqual(mediaEstimate(liteTariff, lite, { resolution: '1K', n: 2 }),
    { status: 'estimated', credits: null, amountUsd: 0.064, nativeCredits: 0.64 });
  assert.equal(mediaEstimate(liteTariff, { id: 'future-image-model', kind: 'image' }).amountUsd, 0.032);
  assert.equal(mediaEstimate({ data: { billing_type: 'tiered_token', paid_price: 0.032 } }, lite), null);
  const nano = { id: 'gemini-3-pro-image-preview', kind: 'image' };
  const nanoTariff = { data: { paid_price: 0.03, resolution_paid_prices: { '4K': 0.04 } } };
  assert.equal(mediaEstimate(nanoTariff, nano, { resolution: '1K', n: 1 }).amountUsd, 0.03);
  assert.equal(mediaEstimate(nanoTariff, nano, { resolution: '2K', n: 1 }).amountUsd, 0.03);
  assert.equal(mediaEstimate(nanoTariff, nano, { resolution: '4K', n: 1 }).amountUsd, 0.04);
  assert.equal(mediaEstimate(nanoTariff, nano, { resolution: '8K', n: 1 }), null);
});

test('published image tariffs account for references and layer preauthorization independent of model ID', () => {
  const tariff = { data: { paid_price: 0.036, resolution_paid_prices: { '1K': 0.02925, '2K': 0.0585 },
    input_image_first_free: true, input_image_paid_price: 0.00195,
    layer_decomposition_paid_prices: { '1K': 0.014625, '2K': 0.02925 }, layer_decomposition_max_images: 17 } };
  const model = { id: 'future-layer-model', kind: 'image' };
  for (const [size, perImage] of [['auto', 0.02925], ['1K', 0.014625], ['1.5K', 0.014625], ['2K', 0.02925]]) {
    const priced = mediaEstimate(tariff, model, { size, image_urls: ['content:one'], layer_decomposition: true });
    assert.equal(priced.amountUsd, perImage * 17);
    assert.match(priced.warning, /17/);
  }
  assert.equal(mediaEstimate(tariff, model, { resolution: '1K', image_urls: ['one', 'two', 'three'] }).amountUsd, 0.02925 + 0.00195 * 2);
  assert.equal(mediaEstimate(tariff, model, { layer_decomposition: true, size: 'unknown', image_urls: ['one'] }), null);
  assert.equal(mediaEstimate({ data: { paid_price: 0.03 } }, model, { layer_decomposition: true, image_urls: ['one'] }), null);
});

test('APIMart Seedance 2.5 quote follows resolution prices despite token billing tiers', () => {
  const model = describeModel({ id: 'seedance-2.5', category: 'video' });
  const tariff = { data: { billing_type: 'per_second', paid_price: 0.216,
    resolution_paid_prices: { '480P': 0.09608, '720P': 0.216, '1080P': 0.38488 },
    billing_tier_paid_prices: { token: 10, 'token-1080P': 11 } } };
  for (const [resolution, amountUsd] of [['480p', 0.4804], ['720p', 1.08], ['1080p', 1.9244]]) {
    const quote = mediaEstimate(tariff, model, { resolution, duration: 5, generate_audio: false });
    assert.ok(Math.abs(quote.amountUsd - amountUsd) < 1e-10, resolution);
    assert.ok(Math.abs(quote.nativeCredits - amountUsd * 10) < 1e-10, resolution);
  }
  assert.ok(Math.abs(mediaEstimate(tariff, model, { resolution: '1080p', duration: 5, generate_audio: true }).amountUsd - 1.9244) < 1e-10);
  assert.equal(mediaEstimate(tariff, model, { resolution: '4k', duration: 5 }), null);
  assert.equal(mediaEstimate(tariff, model, { resolution: '720p', duration: 5,
    video_urls: ['https://example.com/reference.mp4'] }), null);
});

test('APIMart recovers a persisted media task by polling without another paid POST', async () => {
  const account = '11111111-1111-4111-8111-111111111111';
  let saved = { id: '33333333-3333-4333-8333-333333333333', state: 'running', kind: 'video', model: 'kling-v3',
    providerTaskId: 'task_saved', revision: 2, createdAt: new Date().toISOString() };
  const query = async (sql, params = []) => {
    if (sql.startsWith('SELECT account_id')) return { rows: [{ account_id: account, data: saved }] };
    if (sql.startsWith('SELECT data FROM media_records')) return { rows: [{ data: saved }] };
    if (sql.startsWith('UPDATE media_records')) saved = JSON.parse(params[2]);
    return { rows: [] };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  const requests = [];
  const service = createApimartJobs({ pool, apiKey: 'test', fetchImpl: async (url, init) => {
    requests.push({ url, method: init?.method });
    return { ok: true, json: async () => ({ data: { status: 'completed', cost: 0.5, credits_cost: 5,
      result: { videos: [{ url: ['https://example.com/video.mp4'] }] } } }) };
  } });
  await service.recover();
  for (let i = 0; i < 100 && saved.state === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(saved.state, 'success');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.apimart.ai/v1/tasks/task_saved');
  assert.notEqual(requests[0].method, 'POST');
});

test('APIMart catalogue rejects insufficient balance without sending a generation', async () => {
  const requests = [];
  const client = createApimartClient({ apiKey: 'private-test-key', fetchImpl: async url => {
    requests.push(url);
    return { ok: false, status: 402, json: async () => ({ error: { message: 'insufficient balance' } }) };
  } });
  await assert.rejects(() => client.models(), { status: 402 });
  assert.equal(requests.length, 1);
  assert.match(requests[0], /\/models\?expand=category$/);
});

test('APIMart reserves app credits before POST and settles the confirmed provider credits 1:1', async t => {
  const pool = await openDatabase({}, testPool());
  t.after(() => pool.end());
  const account = randomUUID(), emptyAccount = randomUUID();
  for (const id of [account, emptyAccount]) {
    await pool.query('INSERT INTO media_accounts(id,display_name,role) VALUES($1,$2,$3)', [id, 'APIMart billing test', 'admin']);
    await pool.query('INSERT INTO media_wallets(account_id,balance) VALUES($1,$2)', [id, id === account ? 1000 : 0]);
  }
  let paidPosts = 0;
  const service = createApimartJobs({ pool, apiKey: 'test', fetchImpl: async url => {
    if (url.includes('/models?')) return { ok: true, json: async () => ({ data: [{ id: 'gpt-image-2', category: 'image' }] }) };
    if (url.includes('/pricing/model?')) return { ok: true, json: async () => ({ data: { paid_price: 0.01 } }) };
    if (url.endsWith('/images/generations')) { paidPosts++; return { ok: true, json: async () => ({ data: { task_id: 'bill-task' } }) }; }
    if (url.endsWith('/tasks/bill-task')) return { ok: true, json: async () => ({ data: { status: 'completed', cost: 0.015,
      credits_cost: 0.15, result: { images: [{ url: 'https://example.com/billed.png' }] } } }) };
    throw new Error(`Unexpected APIMart request: ${url}`);
  } });
  const request = { requestId: randomUUID(), model: 'gpt-image-2', prompt: 'Test image' };
  const quote = await service.quote(request);
  assert.equal(quote.credits, 0.1);
  await assert.rejects(service.submit(emptyAccount, { ...request, requestId: randomUUID() }), /Недостаточно кредитов/);
  assert.equal(paidPosts, 0);
  const started = await service.submit(account, request);
  assert.equal(started.nativeQuote.amountUnits, 100);
  for (let i = 0; i < 100 && (await service.get(account, request.requestId))?.state === 'running'; i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const finished = await service.get(account, request.requestId);
  assert.equal(finished.state, 'success');
  assert.equal(paidPosts, 1);
  assert.deepEqual((await pool.query('SELECT balance,held FROM media_wallets WHERE account_id=$1', [account])).rows[0],
    { balance: 850, held: 0 });
  const reservation = (await pool.query('SELECT amount,state FROM media_reservations WHERE job_id=$1',
    [`apimart:${account}:${request.requestId}`])).rows[0];
  assert.deepEqual(reservation, { amount: 150, state: 'captured' });
  assert.equal((await service.submit(account, request)).state, 'success');
  assert.equal(paidPosts, 1);
  await pool.query('UPDATE media_wallets SET balance=100 WHERE account_id=$1', [emptyAccount]);
  const shortRequest = { ...request, requestId: randomUUID() };
  await service.submit(emptyAccount, shortRequest);
  for (let i = 0; i < 100 && (await service.get(emptyAccount, shortRequest.requestId))?.state === 'running'; i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const shortJob = await service.get(emptyAccount, shortRequest.requestId);
  assert.equal(shortJob.state, 'unknown');
  assert.equal(shortJob.billingPending, true);
  assert.deepEqual(shortJob.resultUrls, ['https://example.com/billed.png']);
  assert.deepEqual((await pool.query('SELECT balance,held FROM media_wallets WHERE account_id=$1', [emptyAccount])).rows[0],
    { balance: 100, held: 100 });
});


test('standard token quotes accept cache tariff dimensions without assuming cache hits', () => {
  const rates = simpleRates({ data: { pricing: { unit: 'usd_per_million_tokens', tier_count: 1,
    effective_rates: { input: 2.4, cached_input: 0.24, cache_write_5m: 3, cache_write_1h: 4.8, output: 12 } } } });
  assert.deepEqual(rates, { input: 2.4, output: 12 });
  assert.ok(estimate(rates, 'A tree').amountUsd > 0);
  assert.equal(usedCost(rates, { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 8 } }), null);
});

test('fresh quotes bypass the APIMart pricing cache before dispatch', async () => {
  let calls = 0;
  const service = createApimartJobs({ pool: null, apiKey: 'test', fetchImpl: async url => ({ ok: true,
    json: async () => url.includes('/models?') ? { data: [{ id: 'gpt-image-2', category: 'image' }] }
      : { data: { paid_price: ++calls / 100 } } }) });
  const input = { model: 'gpt-image-2', prompt: 'A tree' };
  assert.equal((await service.quote(input)).amountUsd, 0.01);
  assert.equal((await service.quote(input)).amountUsd, 0.01);
  assert.equal((await service.quote(input, { fresh: true })).amountUsd, 0.02);
});

test('image quotes resolve compound aspect/resolution/quality tariffs and conservative auto size', () => {
  const tariff = { data: { billing_type: 'tiered_token',
    resolution_paid_prices: { '1:1': 0.1, '16:9': 0.08, '1:1@2k': 0.2, '16:9@2k': 0.15 },
    size_quality_paid_prices: { '1:1': { auto: 0.1, high: 0.3 }, '16:9': { auto: 0.08, high: 0.2 },
      '1:1@2k': { auto: 0.2, high: 0.6 }, '16:9@2k': { auto: 0.15, high: 0.4 } } } };
  const model = { id: 'any-image-model', kind: 'image' };
  assert.equal(mediaEstimate(tariff, model, { size: '16:9', resolution: '2K', quality: 'high', n: 2 }).amountUsd, 0.8);
  const auto = mediaEstimate(tariff, model, { size: 'auto', resolution: '1K', quality: 'high' });
  assert.equal(auto.amountUsd, 0.3);
  assert.match(auto.warning, /автоматического/);
  assert.equal(mediaEstimate(tariff, model, { size: '16:9', resolution: '4K' }), null);
  assert.equal(mediaEstimate(tariff, model, { size: '1:1', quality: 'unknown' }), null);
});

test('sparse video tariff uses the documented default and never substitutes unknown variants', () => {
  const model = { id: 'any-video', kind: 'video', fields: [{ key: 'resolution', apiDefault: '720p' }, { key: 'duration', apiDefault: 5 }] };
  const tariff = { data: { billing_type: 'per_second', paid_price: 0.05, resolution_paid_prices: { '1080P': 0.08 } } };
  assert.equal(mediaEstimate(tariff, model).amountUsd, 0.25);
  assert.equal(mediaEstimate(tariff, model, { resolution: '1080p' }).amountUsd, 0.4);
  assert.equal(mediaEstimate(tariff, model, { resolution: '4K' }), null);
});
