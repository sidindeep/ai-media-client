const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { testPool } = require('./helpers/pg-pool');
const { openDatabase } = require('../src/database/database');
const { createWallet } = require('../src/billing/wallet');
const { createPricing } = require('../src/billing/pricing');
const { createCodexBilling, priceKey } = require('../src/services/codex-billing');
const { validateCodexRequest, codexArguments } = require('../src/services/codex-request');
const { createCodexWorker, codexEnvironment } = require('../src/services/codex-worker');
const { collectImage, validatePng } = require('../src/services/codex-images');
const request = () => ({ requestId: randomUUID(), prompt: 'Привет', model: 'gpt-6-astra', effort: 'ultra', speed: 'fast' });
const sampleUsage = { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 };

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

test('Every offered Codex mode has the configured four-credit product price', () => {
  const config = require('../config/native-prices.json');
  const pricing = createPricing(config);
  assert.throws(() => pricing.quote('kie:nano-banana-2-lite'), /не опубликована/);
  for (const model of require('../config/codex-models.json').models) {
    for (const effort of model.efforts) for (const speed of ['standard', 'fast']) {
      assert.equal(pricing.quote(priceKey({ model: model.id, effort, speed })).amountUnits, 4000);
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
  assert.equal((await fetch(base + '/jobs/' + input.requestId, { headers: { 'x-account-id': account } }).then(r => r.json())).output, 'ok');
  assert.equal((await post(request())).status, 202);
  finishes.at(-1)('ok');
});

test('Codex credit reservations survive replay, failure and unknown transport', async t => {
  const pool = await openDatabase({}, testPool());
  const account = randomUUID(), second = randomUUID();
  for (const id of [account, second]) {
    await pool.query("INSERT INTO media_accounts(id,display_name) VALUES($1,'Test')", [id]);
    await pool.query('INSERT INTO media_wallets(account_id,balance) VALUES($1,10000)', [id]);
  }
  let mode = 'running', sent = 0;
  const accounts = { pool, wallet: createWallet(pool), pricing: createPricing({ version: 'test', models: { [priceKey(request())]: { baseUnits: 1000 } } }) };
  const billing = createCodexBilling({ accounts, url: 'http://worker', fetchImpl: async (_url, options) => {
    if (options.method === 'POST') sent++;
    if (mode === 'network') throw new Error('network');
    if (mode === 'reject') return { ok: false, status: 429, json: async () => ({ error: 'busy' }) };
    return { ok: true, json: async () => ({ state: mode, output: 'Ответ', usage: sampleUsage, error: 'failed' }) };
  } });
  t.after(async () => { billing.close(); await pool.end(); });
  const input = request();
  const [a,b] = await Promise.all([billing.submit(account, input), billing.submit(account, input)]);
  assert.equal(a.id, b.id); assert.equal(sent, 1);
  assert.equal((await accounts.wallet.get(account)).heldUnits, 1000);
  await assert.rejects(billing.status(second, input.requestId), /не найден/);
  mode = 'success';
  assert.deepEqual((await billing.status(account, input.requestId)).usage, sampleUsage);
  assert.deepEqual((await billing.status(account, input.requestId)).usage, sampleUsage);
  assert.equal((await accounts.wallet.get(account)).balanceUnits, 9000);
  mode = 'running'; const missingImage = await billing.submit(account, { ...request(), kind: 'image' });
  mode = 'success'; assert.equal((await billing.status(account, missingImage.id)).state, 'fail');
  assert.equal((await accounts.wallet.get(account)).heldUnits, 0);
  assert.equal((await accounts.wallet.get(account)).balanceUnits, 9000);
  assert.equal((await accounts.wallet.get(account)).heldUnits, 0);
  await assert.rejects(billing.submit(account, { ...input, prompt: 'changed' }), /другие параметры/);
  mode = 'reject'; await billing.submit(account, request());
  assert.equal((await accounts.wallet.get(account)).heldUnits, 0);
  mode = 'running'; const failing = await billing.submit(account, request());
  mode = 'failed'; assert.equal((await billing.status(account, failing.id)).state, 'fail');
  assert.equal((await accounts.wallet.get(account)).heldUnits, 0);
  assert.equal((await accounts.wallet.get(account)).balanceUnits, 9000);
  mode = 'network'; const unknown = await billing.submit(account, request());
  assert.equal(unknown.state, 'unknown');
  assert.equal((await accounts.wallet.get(account)).heldUnits, 1000);
  mode = 'success'; await billing.status(account, unknown.id);
  assert.equal((await accounts.wallet.get(account)).balanceUnits, 8000);
  mode = 'running'; const uncertain = await billing.submit(account, request());
  mode = 'unknown'; assert.equal((await billing.status(account, uncertain.id)).state, 'unknown');
  assert.equal((await accounts.wallet.get(account)).heldUnits, 1000);
  mode = 'failed'; await billing.status(account, uncertain.id);
  assert.equal((await accounts.wallet.get(account)).heldUnits, 0);
  await assert.rejects(billing.submit(account, { ...request(), speed: 'standard' }), /Цена/);
  await pool.query('UPDATE media_wallets SET balance=0 WHERE account_id=$1', [second]);
  const prior = sent; await assert.rejects(billing.submit(second, request()), /Недостаточно/); assert.equal(sent, prior);
});
