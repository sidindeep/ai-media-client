const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { testPool } = require('./helpers/pg-pool');
const { openDatabase } = require('../src/database/database');
const { createWallet } = require('../src/billing/wallet');
const { createPricing } = require('../src/billing/pricing');
const { priceKey } = require('../src/services/codex-billing');
const { createCodexModule } = require('../src/server/codex-module');
const createCodexBilling = options => createCodexModule(options).billing;
const { createCodexApplicationProvider } = require('../src/providers/codex/application');
const { validateCodexRequest, codexArguments } = require('../src/services/codex-request');
const { createCodexWorker, codexEnvironment } = require('../src/services/codex-worker');
const { collectImage, validatePng } = require('../src/services/codex-images');
const request = () => ({ requestId: randomUUID(), prompt: 'Привет', model: 'gpt-6-astra', effort: 'ultra', speed: 'fast' });
const sampleUsage = { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 };

test('Codex application provider preserves the product quote and account-scoped job contract', async () => {
  const calls = [];
  const billing = {
    models: async () => ({ models: [{ id: 'gpt-6-astra' }] }),
    quote: request => ({ credits: 4, amountUnits: 4000, version: `codex:${request.model}` }),
    submit: async (account, payload) => { calls.push(['submit', account, payload.requestId]); return { id: payload.requestId }; },
    read: async (account, requestId) => { calls.push(['read', account, requestId]); return { id: requestId }; },
  };
  const provider = createCodexApplicationProvider(billing);
  assert.equal(provider.billing.mode, 'wallet');
  assert.ok((await provider.listModels()).some(model => model.id === 'gpt-6-astra'));
  const quote = provider.quote({ model: 'gpt-6-astra' });
  assert.deepEqual(quote, { status: 'exact', credits: 4,
    nativeQuote: { credits: 4, amountUnits: 4000, version: 'codex:gpt-6-astra' } });
  const requestId = randomUUID();
  await provider.submit('account-a', { requestId });
  await provider.getTask('account-a', requestId);
  assert.deepEqual(calls, [['submit', 'account-a', requestId], ['read', 'account-a', requestId]]);
  assert.equal(provider.getStatus().balance, null);
});

test('Web model catalog comes from the active worker and fails closed when it is unavailable', async t => {
  const { createHttpServer } = require('../src/server/http');
  const { loadConfig } = require('../src/server/config');
  let unavailable = false;
  const server = createHttpServer({ config: loadConfig({ MEDIA_PORT: '0', MEDIA_AUTH_ENABLED: 'false' }), service: {},
    accounts: { starterPack: { assertProvider: async () => {} } },
    generationServices: { codexProvider: { listModelCatalog: async () => {
      if (unavailable) throw new Error('worker offline');
      return { source: 'app-server', checkedAt: '2026-09-29T12:00:00.000Z', models: [{ id: 'gpt-6-sol', efforts: ['medium'] }] };
    } } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}/api/codex/models`;
  const response = await fetch(endpoint);
  assert.equal(response.status, 200);
  const catalog = await response.json();
  assert.equal(catalog.source, 'app-server');
  assert.deepEqual(catalog.models.map(model => model.id), ['gpt-6-sol']);
  assert.equal(catalog.uiDefaults.model, 'gpt-5.5');
  unavailable = true;
  const failed = await fetch(endpoint);
  assert.equal(failed.status, 503);
  assert.equal((await failed.json()).models, undefined);
});

test('CLI usage comes only from completed turn metadata, without counting cache or reasoning twice', () => {
  const { parseCodexOutput, normalizeUsage } = require('../src/services/codex-usage');
  const message = { type: 'item.completed', item: { type: 'agent_message', text: '{"usage":{"input_tokens":999999}}' } };
  const output = [message, { type: 'turn.completed', usage: sampleUsage }].map(JSON.stringify).join('\n');
  assert.deepEqual(parseCodexOutput(output).usage, sampleUsage);
  assert.equal(parseCodexOutput(output).output, message.item.text);
  assert.equal(parseCodexOutput(JSON.stringify(message) + '\n{"type":"turn.completed"}').usage, null);
  assert.throws(() => parseCodexOutput(JSON.stringify(message)), /не завершил/);
  assert.equal(normalizeUsage({ input_tokens: -1, output_tokens: 2 }), null);
  assert.equal(normalizeUsage({ input_tokens: 1, output_tokens: 2 }).cached_input_tokens, null);
  assert.ok(codexArguments(request()).includes('--json'));
});

test('Single-container hosting selects loopback and does not expose web secrets to Codex', () => {
  const { loadConfig } = require('../src/server/config');
  const embedded = loadConfig({ PORT: '8080', MEDIA_CODEX_EMBEDDED: 'true' });
  assert.equal(embedded.port, 8080);
  assert.deepEqual(embedded.codex, { url: 'http://127.0.0.1:3210', embedded: true });
  const sidecar = loadConfig({ MEDIA_CODEX_EMBEDDED: 'true', MEDIA_CODEX_URL: 'http://codex:3210' });
  assert.equal(sidecar.codex.embedded, false);
  assert.deepEqual(codexEnvironment({ PATH: '/bin', CODEX_HOME: '/app/data/codex-auth', DATABASE_URL: 'secret', GOOGLE_CLIENT_SECRET: 'secret', KIE_API_KEY: 'secret' }), { PATH: '/bin', CODEX_HOME: '/app/data/codex-auth' });
});

test('Image collection requires this CLI thread and validates PNG instead of model text', async t => {
  const fs = require('node:fs/promises'), path = require('node:path');
  const home = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'codex-image-test-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const thread = randomUUID(), other = randomUUID();
  const directory = path.join(home, 'generated_images', thread);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'answer.txt'), 'image was generated');
  await assert.rejects(collectImage(home, thread), /не создал изображение/);
  await assert.rejects(collectImage(home, '../../auth'), /Не получен файл/);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  await fs.writeFile(path.join(directory, 'generated.png'), png);
  assert.deepEqual((await collectImage(home, thread)).buffer, png);
  await assert.rejects(collectImage(home, other), /не создал изображение/);
  assert.throws(() => validatePng(Buffer.from('not an image')), /корректный PNG/);
});

test('Every offered Codex mode has the configured ten-credit product price', () => {
  const config = require('../config/native-prices.json');
  const pricing = createPricing(config);
  assert.throws(() => pricing.quote('kie:nano-banana-2-lite'), /не опубликована/);
  const liveModels = [
    { id: 'gpt-6-sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
    { id: 'gpt-6-luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  ];
  for (const model of [...require('../config/codex-models.json').models, ...liveModels]) {
    for (const effort of model.efforts) for (const speed of ['standard', 'fast']) {
      assert.equal(pricing.quote(priceKey({ model: model.id, effort, speed })).amountUnits, 10000);
    }
  }
});

test('Codex validates model-specific effort, speed and executable boundary', () => {
  const input = request(); assert.deepEqual(validateCodexRequest(input), input);
  assert.throws(() => validateCodexRequest({ ...input, command: 'injected' }));
  assert.throws(() => validateCodexRequest({ ...input, model: 'gpt-5.5' }));
  assert.throws(() => validateCodexRequest({ ...input, speed: 'free' }));
  assert.ok(codexArguments(input).includes('model_reasoning_effort="ultra"'));
  assert.ok(codexArguments(input).includes('service_tier="fast"'));
  assert.ok(!codexArguments({ ...input, speed: 'standard' }).some(arg => arg.startsWith('service_tier')));
  assert.ok(codexArguments(input).includes('shell_tool'));
  const args = codexArguments({ ...input, kind: 'image' });
  assert.equal(args[args.indexOf('image_generation') - 1], '--enable');
  assert.equal(args[args.indexOf('code_mode_host') - 1], '--enable');
  assert.equal(args[args.indexOf('shell_tool') - 1], '--disable');
  assert.ok(args.includes('--json'));
  assert.throws(() => validateCodexRequest({ ...input, kind: 'video' }));
  const liveModel = { id: 'gpt-6-sol', efforts: ['none', 'medium'] };
  assert.equal(validateCodexRequest({ ...input, model: 'gpt-6-sol', effort: 'none' }, [liveModel]).model, 'gpt-6-sol');
  assert.throws(() => validateCodexRequest({ ...input, model: 'gpt-6-sol', effort: 'ultra' }, [liveModel]));
});

test('Codex accepts content and legacy references and rejects unsupported sources', () => {
  const sourceFiles = [`content:${randomUUID()}`, `https://local-assets.invalid/${'a'.repeat(64)}`];
  assert.deepEqual(validateCodexRequest({ ...request(), sourceFiles }).sourceFiles, sourceFiles);
  for (const ref of ['content:bad', 'content:../../secret', 'https://example.com/photo.png', '/tmp/photo.png', null, {}]) {
    assert.throws(() => validateCodexRequest({ ...request(), sourceFiles: [ref] }), /Некорректные исходные изображения/);
  }
  assert.throws(() => validateCodexRequest({ ...request(), sourceFiles: Array(11).fill(sourceFiles[0]) }), /Некорректные исходные изображения/);
});

test('Codex billing forwards owned content bytes through worker validation', async t => {
  const pool = await openDatabase({}, testPool());
  t.after(() => pool.end());
  const account = randomUUID(), contentId = randomUUID();
  const input = { ...request(), kind: 'image', sourceFiles: [`content:${contentId}`] };
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  await pool.query("INSERT INTO media_accounts(id,display_name) VALUES($1,'Source test')", [account]);
  await pool.query('INSERT INTO media_wallets(account_id,balance) VALUES($1,10000)', [account]);
  const received = [];
  const worker = createCodexWorker(async value => { received.push(value); return 'ok'; });
  await new Promise(resolve => worker.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { worker.closeIdleConnections(); worker.close(resolve); }));
  const accounts = { pool, pricing: createPricing({ version: 'test', models: { [priceKey(input)]: { baseUnits: 1000 } } }) };
  const billing = createCodexBilling({ accounts, url: `http://127.0.0.1:${worker.address().port}`,
    content: { read: async (owner, id) => {
      assert.equal(owner, account);
      if (id !== contentId) throw Object.assign(new Error('Файл не найден'), { status: 404 });
      return png;
    } } });
  t.after(() => billing.close());
  assert.equal((await billing.submit(account, input)).state, 'running');
  assert.equal(received.length, 1);
  assert.deepEqual(received[0].sourceFiles, input.sourceFiles);
  assert.deepEqual(received[0].images, [`data:image/png;base64,${png.toString('base64')}`]);
  const held = (await pool.query('SELECT held FROM media_wallets WHERE account_id=$1', [account])).rows[0].held;
  await assert.rejects(billing.submit(account, { ...input, requestId: randomUUID(), sourceFiles: [`content:${randomUUID()}`] }), /Файл не найден/);
  assert.equal(received.length, 1);
  assert.equal((await pool.query('SELECT held FROM media_wallets WHERE account_id=$1', [account])).rows[0].held, held);
});

test('Codex worker accepts over 100 simultaneous jobs while isolating accounts and deduplicating requests', async t => {
  const finishes = []; let calls = 0;
  const server = createCodexWorker(() => { calls++; return new Promise(resolve => { finishes.push(resolve); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeIdleConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const account = randomUUID(), input = request();
  const post = value => fetch(base + '/jobs', { method: 'POST', headers: { 'x-account-id': account }, body: JSON.stringify(value) });
  assert.equal((await post(input)).status, 202);
  assert.equal((await post(input)).status, 200); assert.equal(calls, 1);
  const parallel = await Promise.all(Array.from({ length: 104 }, () => post(request())));
  assert.ok(parallel.every(response => response.status === 202));
  assert.equal(calls, 105);
  assert.equal((await post(input)).status, 200);
  assert.equal(calls, 105);
  assert.equal((await fetch(base + '/jobs/' + input.requestId, { headers: { 'x-account-id': randomUUID() } })).status, 404);
  finishes.forEach(finish => finish('ok'));
  let completed;
  for (let attempt = 0; attempt < 100; attempt++) {
    completed = await fetch(base + '/jobs/' + input.requestId, { headers: { 'x-account-id': account } }).then(r => r.json());
    if (completed.state === 'success') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(completed.state, 'success');
  assert.equal(completed.output, 'ok');
  assert.equal((await post(request())).status, 202);
  finishes.at(-1)('ok');
});

test('Codex worker stores image bytes outside status and serves them after restart', async t => {
  const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-result-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const account = randomUUID(), input = { ...request(), kind: 'image' };
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const start = async run => {
    const server = createCodexWorker(run, { resultDirectory: directory });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { server, base: `http://127.0.0.1:${server.address().port}` };
  };
  const stop = server => new Promise(resolve => { server.closeIdleConnections(); server.close(resolve); });
  const headers = { 'x-account-id': account };
  const first = await start(async () => ({ output: 'Изображение создано.', imageBase64: png.toString('base64'), usage: sampleUsage }));
  assert.equal((await fetch(first.base + '/jobs', { method: 'POST', headers, body: JSON.stringify(input) })).status, 202);
  let job;
  for (let attempt = 0; attempt < 30; attempt++) {
    job = await fetch(first.base + '/jobs/' + input.requestId, { headers }).then(response => response.json());
    if (job.state === 'success') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(job.state, 'success');
  assert.equal(job.hasImage, true);
  assert.equal(job.imageBase64, undefined);
  const persisted = JSON.parse(await fs.readFile(path.join(directory, account, input.requestId + '.json'), 'utf8'));
  assert.equal(persisted.state, 'success');
  assert.equal(persisted.hasImage, true);
  await stop(first.server);
  const second = await start(() => { throw new Error('must not regenerate'); });
  t.after(() => stop(second.server));
  const restored = await fetch(second.base + '/jobs/' + input.requestId, { headers }).then(response => response.json());
  assert.equal(restored.state, 'success');
  assert.equal(restored.imageBase64, undefined);
  const image = await fetch(second.base + '/jobs/' + input.requestId + '/image', { headers });
  assert.equal(image.status, 200);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
});

test('Codex worker rejects a full queue before accepting a paid request', async t => {
  const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-cap-test-'));
  const server = createCodexWorker(() => new Promise(() => {}), { resultDirectory: directory, maxPendingJobs: 2 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeIdleConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'x-account-id': randomUUID() };
  const first = request(), second = request();
  const post = value => fetch(base + '/jobs', { method: 'POST', headers, body: JSON.stringify(value) });
  assert.equal((await post(first)).status, 202);
  assert.equal((await post(second)).status, 202);
  assert.equal((await post(first)).status, 200);
  const rejected = await post(request());
  assert.equal(rejected.status, 429);
  assert.equal((await rejected.json()).accepted, false);
});

test('Codex billing retrieves durable worker PNG before capturing the reservation', async t => {
  const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-billing-image-test-'));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const worker = createCodexWorker(async () => ({ output: 'Изображение создано.', imageBase64: png.toString('base64'), usage: sampleUsage }), { resultDirectory: directory });
  await new Promise(resolve => worker.listen(0, '127.0.0.1', resolve));
  const pool = await openDatabase({}, testPool());
  t.after(async () => { worker.closeIdleConnections(); await new Promise(resolve => worker.close(resolve)); await pool.end(); await fs.rm(directory, { recursive: true, force: true }); });
  const account = randomUUID(), input = { ...request(), kind: 'image' }, stored = [];
  await pool.query("INSERT INTO media_accounts(id,display_name) VALUES($1,'Codex image')", [account]);
  await pool.query('INSERT INTO media_wallets(account_id,balance) VALUES($1,10000)', [account]);
  const accounts = { pool, pricing: createPricing({ version: 'test', models: { [priceKey(input)]: { baseUnits: 1000 } } }) };
  const base = `http://127.0.0.1:${worker.address().port}`;
  const billing = createCodexBilling({ accounts, url: base, storage: { put: async (_key, bytes) => { stored.push(Buffer.from(bytes)); } } });
  t.after(() => billing.close());
  await billing.submit(account, input);
  for (let attempt = 0; attempt < 30; attempt++) {
    const remote = await fetch(base + '/jobs/' + input.requestId, { headers: { 'x-account-id': account } }).then(response => response.json());
    if (remote.state === 'success') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal((await billing.status(account, input.requestId)).state, 'success');
  assert.deepEqual(stored, [png]);
  assert.equal((await fetch(base + '/jobs/' + input.requestId + '/image', { headers: { 'x-account-id': account } })).status, 404);
  assert.equal(Number((await accounts.pool.query('SELECT held FROM media_wallets WHERE account_id=$1', [account])).rows[0].held), 0);
});

test('Codex credit reservations survive replay, failure and unknown transport', async t => {
  const pool = await openDatabase({}, testPool());
  const account = randomUUID(), second = randomUUID();
  for (const id of [account, second]) {
    await pool.query("INSERT INTO media_accounts(id,display_name) VALUES($1,'Test')", [id]);
    await pool.query('INSERT INTO media_wallets(account_id,balance) VALUES($1,10000)', [id]);
  }
  let mode = 'running', sent = 0, polled = 0;
  const accounts = { pool, wallet: createWallet(pool), pricing: createPricing({ version: 'test', models: { [priceKey(request())]: { baseUnits: 1000 } } }) };
  const billing = createCodexBilling({ accounts, url: 'http://worker', fetchImpl: async (_url, options) => {
    if (_url.endsWith('/models')) return { ok: true, json: async () => require('../config/codex-models.json') };
    if (options.method === 'POST') sent++;
    else polled++;
    if (mode === 'network') throw new Error('network');
    if (mode === 'reject') return { ok: false, status: 403, json: async () => ({ error: 'forbidden' }) };
    if (mode === 'missing') return { ok: false, status: 404, json: async () => ({ error: 'missing' }) };
    return { ok: true, json: async () => ({ state: mode, output: 'Ответ', usage: sampleUsage, error: 'Codex: moderation_blocked: output sexual' }) };
  } });
  t.after(async () => { billing.close(); await pool.end(); });
  const input = request();
  const [a,b] = await Promise.all([billing.submit(account, input), billing.submit(account, input)]);
  assert.equal(a.id, b.id); assert.equal(sent, 1);
  assert.equal((await accounts.wallet.get(account)).heldUnits, 1000);
  const beforePoll = polled;
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => billing.status(account, input.requestId)));
  assert.ok(concurrent.every(job => job.state === 'running'));
  assert.equal(polled - beforePoll, 1);
  const beforeReads = polled;
  assert.equal((await billing.read(account, input.requestId)).state, 'running');
  assert.equal(polled, beforeReads);
  await assert.rejects(billing.status(second, input.requestId), /не найден/);
  mode = 'success';
  assert.deepEqual((await billing.status(account, input.requestId)).usage, sampleUsage);
  assert.deepEqual((await billing.status(account, input.requestId)).usage, sampleUsage);
  assert.equal((await accounts.wallet.get(account)).balanceUnits, 9000);
  mode = 'running'; const missingImage = await billing.submit(account, { ...request(), kind: 'image' });
  mode = 'success'; assert.equal((await billing.status(account, missingImage.id)).state, 'unknown');
  assert.equal((await accounts.wallet.get(account)).heldUnits, 1000);
  assert.equal((await accounts.wallet.get(account)).balanceUnits, 9000);
  await assert.rejects(billing.submit(account, { ...input, prompt: 'changed' }), /другие параметры/);
  mode = 'reject'; await billing.submit(account, request());
  assert.equal((await accounts.wallet.get(account)).heldUnits, 1000);
  mode = 'running'; const failing = await billing.submit(account, request());
  mode = 'failed'; const failed = await billing.status(account, failing.id);
  assert.equal(failed.state, 'fail');
  assert.match(failed.error, /moderation_blocked.*sexual/);
  assert.equal((await billing.read(account, failing.id)).error, failed.error);
  assert.equal((await accounts.wallet.get(account)).heldUnits, 1000);
  assert.equal((await accounts.wallet.get(account)).balanceUnits, 9000);
  mode = 'network'; const unknown = await billing.submit(account, request());
  assert.equal(unknown.state, 'unknown');
  assert.equal((await accounts.wallet.get(account)).heldUnits, 2000);
  mode = 'success'; await billing.status(account, unknown.id);
  assert.equal((await accounts.wallet.get(account)).balanceUnits, 8000);
  mode = 'running'; const uncertain = await billing.submit(account, request());
  mode = 'unknown'; assert.equal((await billing.status(account, uncertain.id)).state, 'unknown');
  assert.equal((await accounts.wallet.get(account)).heldUnits, 2000);
  mode = 'failed'; await billing.status(account, uncertain.id);
  assert.equal((await accounts.wallet.get(account)).heldUnits, 1000);
  mode = 'running'; const missing = await billing.submit(account, request());
  mode = 'missing'; assert.equal((await billing.status(account, missing.id)).state, 'unknown');
  assert.equal((await accounts.wallet.get(account)).heldUnits, 2000);
  await billing.recover();
  assert.equal((await accounts.wallet.get(account)).heldUnits, 2000);
  assert.equal((await billing.status(account, missing.id)).state, 'unknown');
  await assert.rejects(billing.submit(account, { ...request(), speed: 'standard' }), /Цена/);
  await pool.query('UPDATE media_wallets SET balance=0 WHERE account_id=$1', [second]);
  const prior = sent; await assert.rejects(billing.submit(second, request()), /Недостаточно/); assert.equal(sent, prior);
});

test('Codex retries only an explicit unaccepted 429 after restart', async t => {
  const pool = await openDatabase({}, testPool());
  t.after(() => pool.end());
  const account = randomUUID(), input = request();
  await pool.query("INSERT INTO media_accounts(id,display_name) VALUES($1,'Codex retry')", [account]);
  await pool.query('INSERT INTO media_wallets(account_id,balance) VALUES($1,10000)', [account]);
  const accounts = { pool, pricing: createPricing({ version: 'test', models: { [priceKey(input)]: { baseUnits: 1000 } } }) };
  let sends = 0;
  const options = { accounts, url: 'http://worker', retryDelayMs: 150,
    fetchImpl: async (_url, requestOptions) => {
      if (_url.endsWith('/models')) return { ok: true, json: async () => require('../config/codex-models.json') };
      if (requestOptions.method === 'POST') {
        sends++;
        if (sends === 1) return { ok: false, status: 429, json: async () => ({ error: 'busy', accepted: false }) };
        return { ok: true, json: async () => ({ state: 'running' }) };
      }
      return { ok: true, json: async () => ({ state: 'success', output: 'Готово', usage: sampleUsage }) };
    } };
  const first = createCodexBilling(options);
  t.after(() => first.close());
  const queued = await first.submit(account, input);
  assert.equal(queued.state, 'queued');
  assert.equal((await first.status(account, input.requestId)).state, 'queued');
  assert.equal(sends, 1);
  assert.equal((await pool.query('SELECT held FROM media_wallets WHERE account_id=$1', [account])).rows[0].held, 1000);
  first.close();
  const second = createCodexBilling(options);
  t.after(() => second.close());
  await second.recover();
  let job;
  for (let i = 0; i < 100; i++) {
    job = (await pool.query("SELECT data FROM media_records WHERE account_id=$1 AND namespace='codex'", [account])).rows[0].data;
    if (job.state === 'running') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(job.state, 'running');
  assert.equal(sends, 2);
  assert.equal((await second.status(account, input.requestId)).state, 'success');
  assert.deepEqual((await pool.query('SELECT balance,held FROM media_wallets WHERE account_id=$1', [account])).rows[0],
    { balance: 9000, held: 0 });
});

test('Codex does not repeat a 429 without proof that the worker rejected it', async t => {
  const pool = await openDatabase({}, testPool());
  t.after(() => pool.end());
  const account = randomUUID(), input = request();
  await pool.query("INSERT INTO media_accounts(id,display_name) VALUES($1,'Unknown 429')", [account]);
  await pool.query('INSERT INTO media_wallets(account_id,balance) VALUES($1,10000)', [account]);
  let sends = 0;
  const billing = createCodexBilling({ accounts: { pool, pricing: createPricing({ version: 'test', models: { [priceKey(input)]: { baseUnits: 1000 } } }) },
    url: 'http://worker', retryDelayMs: 10,
    fetchImpl: async url => {
      if (url.endsWith('/models')) return { ok: true, json: async () => require('../config/codex-models.json') };
      sends++; return { ok: false, status: 429, json: async () => ({ error: 'busy' }) };
    } });
  t.after(() => billing.close());
  assert.equal((await billing.submit(account, input)).state, 'unknown');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(sends, 1);
  assert.equal((await pool.query('SELECT held FROM media_wallets WHERE account_id=$1', [account])).rows[0].held, 1000);
});
