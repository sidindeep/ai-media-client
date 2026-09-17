const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { start } = require('../server');
const { loadConfig } = require('../src/server/config');
const { createMediaService } = require('../src/services/media-service');
const { createTelegramBot } = require('../src/services/telegram-bot');
const { createTelegramGateway } = require('../src/services/telegram-gateway');
const { models } = require('../src/catalog');
const model = models.find(item => item.apiModel === 'grok-imagine-video-1-5-preview');
const input = { prompt: 'Тест кота', duration: 8, aspect_ratio: '16:9', resolution: '720p' };
const fakeProvider = () => ({ id: 'kie', isConfigured: () => true, upload: async () => 'https://example.test/source', create: async () => ({ taskId: 'remote-1' }), poll: async () => ({ state: 'success', resultJson: '{"resultUrls":["https://example.test/result.mp4"]}', creditsConsumed: 2 }), balance: async () => 100 });
async function directory(t) {
  const base = path.resolve(__dirname, '../artifacts'); await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'web-test-'));
  t.after(async () => { assert.ok(dir.startsWith(base + path.sep)); await fs.rm(dir, { recursive: true, force: true }); });
  return dir;
}

test('web serves shared forms, no credentials UI, strict API boundary and persistent drafts', async t => {
  const dir = await directory(t);
  const config = { ...loadConfig({ MEDIA_PORT: '0' }), dataDirectory: dir };
  const runtime = await start({ config, provider: fakeProvider() }); t.after(() => runtime.close());
  const base = `http://127.0.0.1:${runtime.server.address().port}`;
  const rpc = (name, args) => fetch(`${base}/api/rpc/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Media-Client': 'web' }, body: JSON.stringify(args) });
  const html = await fetch(base).then(r => r.text());
  assert.ok(html.includes('generationForm')); assert.ok(html.includes('pauseQueue'));
  assert.ok(!html.includes('id="apiKey"')); assert.ok(!html.includes('id="openKieSession"'));
  for (const src of [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1])) assert.equal((await fetch(base + src)).status, 200);
  assert.equal((await fetch(base + '/src/main.js')).status, 404);
  assert.equal((await fetch(base + '/.env')).status, 404);
  assert.equal((await fetch(base + '/api/rpc/startQueue', { method: 'POST', body: '[]' })).status, 403);
  assert.equal((await fetch(base + '/api/rpc/startQueue', { method: 'POST', headers: { Origin: 'https://other.test', 'X-Media-Client': 'web' }, body: '[]' })).status, 403);
  const health = await fetch(base + '/api/health').then(r => r.json()); assert.equal(health.generationConfigured, true);
  const draft = { version: 1, active: 0, tabs: [{ prompt: 'Русский черновик' }] };
  assert.equal((await rpc('saveDrafts', [draft])).status, 200);
  assert.deepEqual((await rpc('loadDrafts', []).then(r => r.json())).result, draft);
  assert.equal((await rpc('saveKey', ['kie', 'secret'])).status, 400);
  const catalog = (await rpc('getCatalog', []).then(r => r.json())).result;
  assert.equal(catalog.models.length, models.length);
  assert.equal(catalog.providers[0].baseUrl, undefined);
  const source = await fetch(base + '/api/source?name=cat.png', { method: 'POST', headers: { 'X-Media-Client': 'web', 'Content-Type': 'image/png' }, body: Buffer.from('abcd') }).then(r => r.json());
  const url = base + '/api/sources/' + source.result.ref.split('/').at(-1);
  const range = await fetch(url, { headers: { Range: 'bytes=1-2' } }); assert.equal(range.status, 206); assert.equal(await range.text(), 'bc');
  assert.equal((await fetch(base + '/api/source?name=x.html', { method: 'POST', headers: { 'X-Media-Client': 'web', 'Content-Type': 'text/html' }, body: 'x' })).status, 400);
});

test('service deduplicates enqueue, validates exact model id and keeps queue on server', async t => {
  const dir = await directory(t); let sent = 0;
  const provider = fakeProvider(); provider.create = async () => { sent++; return { taskId: 'remote-1' }; };
  const service = await createMediaService({ directory: dir, provider, interval: 5 }); t.after(() => service.close());
  const request = { modelId: model.id, input, requestId: 'same-request' };
  const [a, b] = await Promise.all([service.createTask(request), service.createTask(request)]);
  assert.equal(a.id, b.id); assert.equal((await service.listHistory()).length, 1);
  await assert.rejects(service.createTask({ ...request, input: { ...input, prompt: 'different' } }), /другими параметрами/);
  await assert.rejects(service.createTask({ modelId: 'absent', input }), /не найдена/);
  service.queue.start();
  for (let i = 0; i < 100 && (await service.listHistory())[0].state !== 'success'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await service.listHistory())[0].state, 'success'); assert.equal(sent, 1);
  const other = await service.createTask({ ...request, requestId: 'second' }); service.queue.pause();
  assert.equal(other.state, 'queued');
});

test('unconfigured service starts and refuses paid task without fabricating output', async t => {
  const dir = await directory(t); const provider = fakeProvider(); provider.isConfigured = () => false;
  const service = await createMediaService({ directory: dir, provider }); t.after(() => service.close());
  assert.equal(service.configured(), false);
  await assert.rejects(service.createTask({ modelId: model.id, input }), /не подключена/);
  assert.equal((await service.listHistory()).length, 0);
});

test('Telegram requires private allowlisted user and confirms once with durable request id', async t => {
  const dir = await directory(t);
  const service = await createMediaService({ directory: dir, provider: fakeProvider() }); t.after(() => service.close());
  const bot = createTelegramBot({ service, directory: dir, allowedUsers: ['42'], downloadFile: async () => Buffer.from('image') });
  const message = text => ({ message: { text, chat: { id: 42, type: 'private' }, from: { id: 42 } } });
  const callback = data => ({ callback_query: { data, from: { id: 42 }, message: { chat: { id: 42, type: 'private' } } } });
  assert.equal(await bot.handle({ message: { text: '/start', chat: { id: 7, type: 'private' }, from: { id: 7 } } }), null);
  assert.equal(await bot.handle({ message: { text: '/start', chat: { id: 42, type: 'group' }, from: { id: 42 } } }), null);
  await bot.handle(callback(`model:${models.indexOf(model)}`));
  await bot.handle(message('Кот на луне'));
  assert.equal((await service.listHistory()).length, 0);
  const confirmation = await bot.handle(callback('generate'));
  const go = confirmation.reply_markup.inline_keyboard[0][0].callback_data;
  await bot.handle(callback(go)); await bot.handle(callback(go));
  assert.equal((await service.listHistory()).length, 1);
  await bot.handle(message('Другой промпт'));
  await assert.rejects(bot.handle(callback(go)), /устарело/);
});

test('Telegram polling offsets survive restart and token-bearing failures are redacted', async t => {
  const dir = await directory(t);
  const service = await createMediaService({ directory: dir, provider: fakeProvider() }); t.after(() => service.close());
  let observedOffset;
  const config = { enabled: true, token: 'test-token', users: ['42'] };
  const gateway = createTelegramGateway({ service, config, directory: dir, fetchImpl: async (url, options) => {
    if (url.endsWith('/getUpdates')) return { ok: true, json: async () => ({ ok: true, result: [{ update_id: 10, message: { text: '/start', chat: { id: 42, type: 'private' }, from: { id: 42 } } }] }) };
    return { ok: true, json: async () => ({ ok: true, result: {} }) };
  } });
  await gateway.pollOnce();
  const next = createTelegramGateway({ service, config, directory: dir, fetchImpl: async (_url, options) => {
    observedOffset = JSON.parse(options.body).offset; return { ok: true, json: async () => ({ ok: true, result: [] }) };
  } });
  await next.pollOnce(); assert.equal(observedOffset, 11);
  const failing = createTelegramGateway({ service, config, directory: dir, fetchImpl: async () => { throw Error('https://private/test-token'); } });
  await assert.rejects(failing.pollOnce(), error => !error.message.includes('test-token'));
});

test('config rejects external data paths and unconfigured enabled bot', () => {
  assert.throws(() => loadConfig({ MEDIA_DATA_DIR: '../outside' }), /внутри проекта/);
  assert.throws(() => loadConfig({ TELEGRAM_ENABLED: 'true' }), /TELEGRAM/);
});
