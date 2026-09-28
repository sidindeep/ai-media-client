const test = require('node:test');
const assert = require('node:assert/strict');
const { createApimartClient } = require('../src/providers/apimart/client');
const { createApimartJobs } = require('../src/services/apimart-jobs');
const { defineProvider } = require('../src/providers/contract');
const { simpleRates, estimate, usedCost, mediaEstimate } = require('../src/providers/apimart/pricing');
const { readProviderStatus } = require('../src/services/provider-status');
const { describeModel } = require('../src/providers/apimart/catalog');

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

test('APIMart quote uses only simple effective token rates and keeps external credits separate', () => {
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
  const jobsService = createApimartJobs({ pool, apiKey: 'private-test-key', fetchImpl });
  assert.equal(jobsService.provider.billing.mode, 'external');
  const quoted = await jobsService.provider.quote({ model: 'gpt-4o', prompt: 'Привет' });
  assert.equal(quoted.status, 'estimated');
  assert.equal(quoted.credits, null);
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
    return { ok: true, json: async () => url.includes('/models?') ? { data: [{ id: 'gpt-image-2', category: 'image', capability_tags: ['Text to Image'] }] }
      : url.endsWith('/images/generations') ? { data: [{ task_id: 'task_example' }] }
        : { data: { status: 'completed', cost: 0.15, credits_cost: 1.5,
          result: { images: [{ url: ['https://example.com/result.png'] }] } } } };
  };
  const service = createApimartJobs({ pool, apiKey: 'private-test-key', fetchImpl });
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
    const data = url.includes('/models?') ? [{ id: 'seedance-1-5-pro', category: 'video' }]
      : url.endsWith('/uploads/images') ? { url: 'https://upload.apimart.ai/f/image/reference.png' }
        : url.endsWith('/videos/generations') ? [{ task_id: 'video_task' }]
          : { status: 'completed', cost: 0.22, credits_cost: 2.2,
            result: { videos: [{ url: 'https://example.com/video.mp4' }] } };
    return { ok: true, json: async () => url.endsWith('/uploads/images') ? data : { data } };
  };
  const service = createApimartJobs({ pool: { query, connect: async () => ({ query, release() {} }) },
    content, apiKey: 'private-test-key', fetchImpl });
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
});

test('APIMart recovers a persisted media task by polling without another paid POST', async () => {
  const account = '11111111-1111-4111-8111-111111111111';
  let saved = { id: '33333333-3333-4333-8333-333333333333', state: 'running', kind: 'video', model: 'kling-v3',
    providerTaskId: 'task_saved', revision: 2, createdAt: new Date().toISOString() };
  const query = async (sql, params = []) => {
    if (sql.startsWith('SELECT account_id')) return { rows: [{ account_id: account, data: saved }] };
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
