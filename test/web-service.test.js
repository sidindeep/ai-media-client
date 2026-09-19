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
test('temporary database failure gives a retryable page and an unhealthy API status', async t => {
  const unavailable = async () => { throw Object.assign(new Error('private database details'), { code: 'EAI_AGAIN' }); };
  const server = require('../src/server/http').createHttpServer({ config: loadConfig({ MEDIA_PORT: '0' }), service: {}, auth: { user: unavailable, providers: () => [] }, accounts: { pool: { query: unavailable } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeIdleConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(base); assert.equal(page.status, 503); assert.equal(page.headers.get('retry-after'), '5');
  const html = await page.text(); assert.match(html, /Повторить/); assert.doesNotMatch(html, /private database details/);
  assert.equal((await fetch(base + '/api/health')).status, 503);
  const version = await fetch(base + '/api/version');
  assert.equal(version.status, 200);
  assert.equal(version.headers.get('cache-control'), 'no-store');
  const release = await version.json();
  assert.equal(release.version, require('../package.json').version);
  assert.equal(release.channel, 'debug');
  assert.equal((await fetch(base + '/version.js')).status, 200);
  assert.match(release.build, /^[a-f0-9]{12}$/);
});
test('protected scripts retry transient session reads without initializing account storage or bypassing access', async t => {
  let attempts = 0, failure = 'once', role = 'user';
  const auth = { providers: () => [], user: async () => {
    attempts++;
    if (failure === 'always' || (failure === 'once' && attempts === 1)) throw Object.assign(new Error('Connection terminated'), { code: 'ECONNRESET' });
    return role ? { id: 'test', role } : null;
  } };
  const server = require('../src/server/http').createHttpServer({
    config: loadConfig({ MEDIA_PORT: '0' }), service: {}, auth,
    accounts: { scope: async () => { throw new Error('Static assets must not initialize a workspace'); } }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeIdleConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const script = await fetch(base + '/shared/file-drop.js');
  assert.equal(script.status, 200); assert.equal(attempts, 2);
  assert.match(await script.text(), /window.attachFileDrop=function/);
  failure = 'none'; attempts = 0;
  assert.equal((await fetch(base + '/shared/costs.js')).status, 403);
  assert.equal(attempts, 1);
  role = null; attempts = 0;
  assert.equal((await fetch(base + '/shared/file-drop.js')).status, 401);
  assert.equal(attempts, 1);
  failure = 'always'; attempts = 0;
  assert.equal((await fetch(base + '/shared/file-drop.js')).status, 503);
  assert.equal(attempts, 3);
  attempts = 0;
  assert.equal((await fetch(base + '/api/rpc/createTask', { method: 'POST' })).status, 503);
  assert.equal(attempts, 1, 'paid requests must not be retried');
});
async function directory() {
  const base = path.resolve(__dirname, '../artifacts'); await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'web-test-'));
  return dir;
}

async function cleanup(dir, resource) {
  await resource.close();
  const base = path.resolve(__dirname, '../artifacts');
  assert.ok(dir.startsWith(base + path.sep));
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
}

test('web serves shared forms, no credentials UI, strict API boundary and persistent drafts', async t => {
  const dir = await directory();
  const config = { ...loadConfig({ MEDIA_PORT: '0', MEDIA_AUTH_ENABLED: 'false' }), dataDirectory: dir };
  const runtime = await start({ config, provider: fakeProvider() }); t.after(() => cleanup(dir, runtime));
  const base = `http://127.0.0.1:${runtime.server.address().port}`;
  const rpc = (name, args) => fetch(`${base}/api/rpc/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Media-Client': 'web' }, body: JSON.stringify(args) });
  const html = await fetch(base).then(r => r.text());
  assert.ok(html.includes('generationForm')); assert.ok(html.includes('pauseQueue'));
  assert.ok(!html.includes('id="apiKey"')); assert.ok(!html.includes('id="openKieSession"'));
  for (const src of [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1])) assert.equal((await fetch(base + src)).status, 200);
  const vueApp = await fetch(base + '/app');
  assert.equal(vueApp.status, 200);
  const vueHtml = await vueApp.text();
  const vueAsset = [...vueHtml.matchAll(/(?:src|href)="(\/app\/assets\/[^"']+)"/g)].map(match => match[1]);
  assert.ok(vueAsset.length >= 2);
  for (const asset of vueAsset) assert.equal((await fetch(base + asset)).status, 200);
  assert.equal((await fetch(base + '/app/projects/demo')).status, 200);
  assert.equal((await fetch(base + '/src/main.js')).status, 404);
  assert.equal((await fetch(base + '/.env')).status, 404);
  const navigation = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
  // Use node:http: fetch overrides Sec-Fetch-Mode with "cors".
  const requestStatus = (route, method = 'GET', headers = navigation) => new Promise((resolve, reject) => {
    const request = require('node:http').request(base + route, { method, headers }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject); request.end();
  });
  assert.equal(await requestStatus('/'), 200);
  assert.equal(await requestStatus('/index.html', 'HEAD'), 200);
  assert.equal(await requestStatus('/', 'POST'), 403);
  assert.equal(await requestStatus('/api/health'), 403);
  assert.equal(await requestStatus('/api/events'), 403);
  assert.equal(await requestStatus('/api/rpc/getCatalog', 'POST'), 403);
  assert.equal(await requestStatus('/', 'GET', { ...navigation, 'Sec-Fetch-Dest': 'iframe' }), 403);
  assert.equal(await requestStatus('/', 'GET', { ...navigation, Host: 'other.test' }), 403);
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
  const dir = await directory(); let sent = 0;
  const provider = fakeProvider(); provider.create = async () => { sent++; return { taskId: 'remote-1' }; };
  const service = await createMediaService({ directory: dir, provider, interval: 5 }); t.after(() => cleanup(dir, service));
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
  const dir = await directory(); const provider = fakeProvider(); provider.isConfigured = () => false;
  const service = await createMediaService({ directory: dir, provider }); t.after(() => cleanup(dir, service));
  assert.equal(service.configured(), false);
  await assert.rejects(service.createTask({ modelId: model.id, input }), /не подключена/);
  assert.equal((await service.listHistory()).length, 0);
});

test('Telegram accepts new private users and confirms once with durable request id', async t => {
  const dir = await directory();
  const service = await createMediaService({ directory: dir, provider: fakeProvider() }); t.after(() => cleanup(dir, service));
  const bot = createTelegramBot({ service, directory: dir, allowedUsers: ['42'], downloadFile: async () => Buffer.from('image') });
  const message = text => ({ message: { text, chat: { id: 42, type: 'private' }, from: { id: 42 } } });
  const callback = data => ({ callback_query: { data, from: { id: 42 }, message: { chat: { id: 42, type: 'private' } } } });
  assert.ok((await bot.handle({ message: { text: '/start', chat: { id: 7, type: 'private' }, from: { id: 7 } } })).text.includes('Медиастудия'));
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
  const dir = await directory();
  const service = await createMediaService({ directory: dir, provider: fakeProvider() }); t.after(() => cleanup(dir, service));
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


test('public Telegram isolates history and delivers results without an allowlist', async t => {
  const dir = await directory();
  const service = await createMediaService({ directory: dir, provider: fakeProvider() }); t.after(() => cleanup(dir, service));
  await service.history.update('other', { telegramChatId: '42', state: 'queued', modelName: 'Private task' });
  await service.history.update('mine', { telegramChatId: '7', state: 'success', modelName: 'My task', resultJson: '{"resultUrls":["https://example.test/mine.png"]}' });
  const bot = createTelegramBot({ service, directory: dir, allowedUsers: ['42'] });
  const message = text => ({ message: { text, chat: { id: 7, type: 'private' }, from: { id: 7 } } });
  const callback = data => ({ callback_query: { data, from: { id: 7 }, message: { chat: { id: 7, type: 'private' } } } });
  const history = await bot.handle(message('/history'));
  assert.ok(history.text.includes('My task')); assert.ok(!history.text.includes('Private task'));
  assert.ok((await bot.handle(callback('cancel:other'))).text.includes('недоступна'));
  const paused = service.queue.paused; await bot.handle(callback('resume')); assert.equal(service.queue.paused, paused);
  assert.ok(!(await bot.handle(message('/queue'))).text.includes('Private task'));
  const config = loadConfig({ TELEGRAM_ENABLED: 'true', TELEGRAM_BOT_TOKEN: 'test-token' }).telegram;
  const sent = [];
  const gateway = createTelegramGateway({ service, config, directory: dir, fetchImpl: async (url, options) => {
    if (url.endsWith('/sendMessage')) sent.push(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => ({ ok: true, result: url.endsWith('/getUpdates') ? [] : {} }) };
  } });
  assert.equal(gateway.status().configured, true);
  await gateway.pollOnce();
  assert.equal(sent.length, 1); assert.equal(sent[0].chat_id, '7');
  assert.ok(sent[0].text.includes('mine.png'));
});


test('Telegram access switches from public to allowlist and back without losing sessions', async t => {
  const dir = await directory();
  const service = await createMediaService({ directory: dir, provider: fakeProvider() }); t.after(() => cleanup(dir, service));
  const message = id => ({ message: { text: '/start', chat: { id, type: 'private' }, from: { id } } });
  const open = createTelegramBot({ service, directory: dir, allowedUsers: ['42'], publicAccess: true });
  assert.ok(await open.handle(message(7)));
  const prompt = message(7); prompt.message.text = "Saved prompt"; await open.handle(prompt);
  const closed = createTelegramBot({ service, directory: dir, allowedUsers: ['42'], publicAccess: false });
  assert.equal(await closed.handle(message(7)), null);
  assert.ok(await closed.handle(message(42)));
  assert.equal(closed.accepts({ callback_query: { from: { id: 7 }, message: { chat: { id: 7, type: 'private' } } } }), false);
  assert.equal(createTelegramBot({ service, directory: dir, publicAccess: false }).accepts(message(7)), false);
  const reopened = createTelegramBot({ service, directory: dir, publicAccess: true });
  assert.ok(await reopened.handle(message(7)));
  assert.ok((await reopened.sessions.list()).some(row => row.id === '7'));
  await service.history.update('result', { telegramChatId: '7', state: 'success', modelName: 'Test', resultJson: '{"resultUrls":[]}' });
  const sent = [];
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/sendMessage')) sent.push(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => ({ ok: true, result: url.endsWith('/getUpdates') ? [] : {} }) };
  };
  const config = { enabled: true, token: 'test-token', users: ['42'], publicAccess: false };
  await createTelegramGateway({ service, config, directory: dir, fetchImpl }).pollOnce();
  assert.equal(sent.length, 0);
  await createTelegramGateway({ service, config: { ...config, publicAccess: true }, directory: dir, fetchImpl }).pollOnce();
  assert.equal(sent.length, 1);
  assert.equal(loadConfig({}).telegram.publicAccess, true);
  assert.equal(loadConfig({ TELEGRAM_PUBLIC_ACCESS: 'false' }).telegram.publicAccess, false);
  assert.throws(() => loadConfig({ TELEGRAM_PUBLIC_ACCESS: 'typo' }), /TELEGRAM_PUBLIC_ACCESS/);
});
