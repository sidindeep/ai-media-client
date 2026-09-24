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
const { createDatabaseAvailability } = require('../src/database/availability');
const model = models.find(item => item.apiModel === 'grok-imagine-video-1-5-preview');
const input = { prompt: 'Тест кота', duration: 8, aspect_ratio: '16:9', resolution: '720p' };
const fakeProvider = () => ({ id: 'kie', isConfigured: () => true, upload: async () => 'https://example.test/source', create: async () => ({ taskId: 'remote-1' }), poll: async () => ({ state: 'success', resultJson: '{"resultUrls":["https://example.test/result.mp4"]}', creditsConsumed: 2 }), balance: async () => 100 });
function mp4Bytes(seconds, timescale = 8000) {
  const mvhdPayload = Buffer.alloc(20); mvhdPayload.writeUInt32BE(timescale, 12); mvhdPayload.writeUInt32BE(Math.round(seconds * timescale), 16);
  const box = (type, payload) => { const value = Buffer.alloc(8 + payload.length); value.writeUInt32BE(value.length, 0); value.write(type, 4, 4, 'ascii'); payload.copy(value, 8); return value; };
  return Buffer.concat([box('ftyp', Buffer.from('isom')), box('moov', box('mvhd', mvhdPayload))]);
}
test('temporary database failure keeps the public landing and Vue shell available with startup status and unhealthy API health', async t => {
  const databaseQueries = [];
  const unavailable = async () => { throw Object.assign(new Error('private database details'), { code: 'EAI_AGAIN' }); };
  const query = async request => { databaseQueries.push(request?.text || request); return unavailable(); };
  const server = require('../src/server/http').createHttpServer({ config: loadConfig({ MEDIA_PORT: '0' }), service: {}, auth: { user: unavailable, providers: () => [] }, accounts: { pool: { query } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeIdleConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(base); assert.equal(page.status, 200);
  const landing = await page.text(); assert.match(landing, /account-id" content="pending/); assert.match(landing, /\/app\/assets\//); assert.doesNotMatch(landing, /private database details/);
  const legal = await fetch(base + '/legal/privacy'); assert.equal(legal.status, 200);
  assert.match(await legal.text(), /Политика обработки персональных данных/);
  assert.equal(databaseQueries.length, 0, 'public legal pages must not read the database');
  const app = await fetch(base + '/app'); assert.equal(app.status, 200);
  const html = await app.text(); assert.match(html, /account-id" content="pending/); assert.match(html, /\/app\/assets\//); assert.doesNotMatch(html, /private database details/);
  const startup = await fetch(base + '/api/startup'); assert.equal(startup.status, 200);
  assert.deepEqual(await startup.json(), { database: { state: 'unavailable', code: 'EAI_AGAIN', pool: {} }, provider: { state: 'idle' }, authenticated: false, account: null });
  assert.equal(databaseQueries.length, 1);
  assert.match(databaseQueries[0], /^SELECT 1 AS connected$/);
  assert.equal((await fetch(base + '/api/health')).status, 503);
  assert.match(databaseQueries.at(-1), /pg_stat_activity/);
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
test('read-only native quote retries transient PostgreSQL session and account lookups', async t => {
  const user = { id: '11111111-1111-1111-1111-111111111111', role: 'user' };
  let authAttempts = 0, scopeAttempts = 0;
  const transient = () => Object.assign(new Error('connection failure'), { code: '08006' });
  const auth = {
    providers: () => [],
    user: async () => { if (++authAttempts === 1) throw transient(); return user; },
  };
  const accounts = {
    scope: async () => {
      if (++scopeAttempts === 1) throw transient();
      return { dispatch: async method => {
        assert.equal(method, 'nativeQuote');
        return { credits: 4, amountUnits: 4000 };
      } };
    },
  };
  const server = require('../src/server/http').createHttpServer({ config: loadConfig({ MEDIA_PORT: '0' }), service: {}, auth, accounts });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeIdleConnections(); server.close(resolve); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/rpc/nativeQuote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Media-Client': 'web', 'X-Media-User': user.id },
    body: JSON.stringify([{ modelId: 'kie:nano-banana-2-lite', input: { prompt: 'Кот' } }]),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { result: { credits: 4, amountUnits: 4000 } });
  assert.equal(authAttempts, 2);
  assert.equal(scopeAttempts, 2);
});
test('read-only provider diagnostics waits for the database services to recover', async t => {
  const user = { id: '11111111-1111-1111-1111-111111111111', role: 'user' };
  const databaseAvailability = createDatabaseAvailability({ state: 'connecting' });
  const service = { dispatch: async method => {
    assert.equal(method, 'diagnoseProvider');
    return { ok: true, provider: 'Kie.ai', checks: [] };
  } };
  const server = require('../src/server/http').createHttpServer({
    config: loadConfig({ MEDIA_PORT: '0' }), service: {}, databaseAvailability, databaseWaitMs: 1000,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { databaseAvailability.close(); server.closeIdleConnections(); server.close(resolve); }));
  const response = fetch(`http://127.0.0.1:${server.address().port}/api/rpc/diagnoseProvider`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Media-Client': 'web', 'X-Media-User': user.id },
    body: JSON.stringify([{ modelId: 'kie:nano-banana-2-lite', input: { prompt: 'Кот' } }]),
  });
  await new Promise(resolve => setTimeout(resolve, 50));
  await server.setAccountServices(
    { providers: () => [], user: async () => user },
    { scope: async () => service },
  );
  databaseAvailability.update({ state: 'connected' });
  const result = await response;
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { result: { ok: true, provider: 'Kie.ai', checks: [] } });
});
test('workspace sync returns one full snapshot and then only cursor-bounded deltas', async t => {
  const user = { id: '11111111-1111-1111-1111-111111111111', role: 'user' };
  const calls = [];
  const cursorValues = ['2026-09-21T10:00:00.000Z', '2026-09-21T10:00:05.000Z'];
  const service = {
    events: new EventEmitter(),
    dispatch: async (method, args = []) => {
      calls.push({ method, args });
      if (method === 'getHistory') return [{ id: 'first', state: 'success' }];
      if (method === 'getHistoryDelta') return [{ id: 'second', state: 'success' }];
      if (method === 'queueStatus') return { paused: false, error: null, concurrency: 3 };
      throw new Error(`Unexpected ${method}`);
    },
  };
  const accounts = {
    pool: { query: async text => {
      assert.match(text, /clock_timestamp/);
      return { rows: [{ cursor: new Date(cursorValues.shift()) }] };
    } },
    scope: async () => service,
    workspaces: {
      ensureDefaultChat: async accountId => { assert.equal(accountId, user.id); return { id: 'chat-full' }; },
      listProjects: async () => [{ id: 'project-full' }],
      listChats: async () => [{ id: 'chat-full' }],
      listProjectChanges: async (_account, since, before) => [{ id: `project:${since}:${before}` }],
      listChatChanges: async (_account, since, before) => [{ id: `chat:${since}:${before}` }],
    },
  };
  const auth = { providers: () => [], user: async () => user };
  const server = require('../src/server/http').createHttpServer({ config: loadConfig({ MEDIA_PORT: '0' }), service, auth, accounts });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeIdleConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;

  const full = await fetch(base + '/api/workspace/sync').then(response => response.json()).then(body => body.result);
  assert.equal(full.full, true);
  assert.equal(full.cursor, '2026-09-21T10:00:00.000Z');
  assert.deepEqual(full.records.map(item => item.id), ['first']);
  assert.deepEqual(full.projects.map(item => item.id), ['project-full']);
  assert.deepEqual(full.chats.map(item => item.id), ['chat-full']);

  const delta = await fetch(base + `/api/workspace/sync?since=${encodeURIComponent(full.cursor)}`).then(response => response.json()).then(body => body.result);
  assert.equal(delta.full, false);
  assert.equal(delta.cursor, '2026-09-21T10:00:05.000Z');
  assert.deepEqual(delta.records.map(item => item.id), ['second']);
  assert.match(delta.projects[0].id, /^project:2026-09-21T10:00:00.000Z:2026-09-21T10:00:05.000Z$/);
  assert.match(delta.chats[0].id, /^chat:2026-09-21T10:00:00.000Z:2026-09-21T10:00:05.000Z$/);
  assert.deepEqual(calls.filter(call => call.method.startsWith('getHistory')), [
    { method: 'getHistory', args: [] },
    { method: 'getHistoryDelta', args: [{ since: '2026-09-21T10:00:00.000Z', before: '2026-09-21T10:00:05.000Z', activeIds: [] }] },
  ]);
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

test('service starts the Vue shell while the database connects in the background', async t => {
  const dir = await directory();
  let attempts = 0;
  const config = { ...loadConfig({ MEDIA_PORT: '0', DATABASE_URL: 'postgres://startup.invalid/test' }), dataDirectory: dir };
  const runtime = await start({
    config, provider: fakeProvider(), startupChecks: false,
    databaseOpener: async () => { attempts++; throw Object.assign(new Error('not ready'), { code: 'ECONNREFUSED' }); },
  });
  t.after(() => cleanup(dir, runtime));
  const base = `http://127.0.0.1:${runtime.server.address().port}`;
  assert.equal((await fetch(base)).status, 200);
  const startup = await fetch(base + '/api/startup').then(response => response.json());
  assert.ok(['connecting', 'unavailable'].includes(startup.database.state));
  assert.equal(startup.authenticated, false);
  assert.equal((await fetch(base + '/api/rpc/getHistory', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Media-Client': 'web' }, body: '[]' })).status, 503);
  assert.ok(attempts >= 1);
});

test('web serves shared forms, no credentials UI, strict API boundary and persistent drafts', async t => {
  const dir = await directory();
  const config = { ...loadConfig({ MEDIA_PORT: '0', MEDIA_AUTH_ENABLED: 'false' }), dataDirectory: dir };
  const runtime = await start({ config, provider: fakeProvider() }); t.after(() => cleanup(dir, runtime));
  const base = `http://127.0.0.1:${runtime.server.address().port}`;
  const rpc = (name, args) => fetch(`${base}/api/rpc/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Media-Client': 'web' }, body: JSON.stringify(args) });
  const html = await fetch(base + '/legacy').then(r => r.text());
  assert.ok(html.includes('generationForm')); assert.ok(html.includes('pauseQueue'));
  assert.ok(!html.includes('id="apiKey"')); assert.ok(!html.includes('id="openKieSession"'));
  for (const src of [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1])) assert.equal((await fetch(base + src)).status, 200);
  const landing = await fetch(base);
  assert.equal(landing.status, 200);
  const landingHtml = await landing.text();
  assert.match(landingHtml, /<meta name="account-id" content="local">/);
  assert.match(landingHtml, /<meta name="account-role" content="admin">/);
  assert.match(landingHtml, /\/app\/assets\//);
  assert.match(landingHtml, /src="\/theme\.js"/);
  assert.equal((await fetch(base + '/landing.css')).status, 200);
  assert.equal((await fetch(base + '/landing.js')).status, 200);
  const brandLogo = await fetch(base + '/brand-logo.png');
  assert.equal(brandLogo.status, 200);
  assert.equal(brandLogo.headers.get('content-type'), 'image/png');
  const landingIcon = await fetch(base + '/landing-model-icons/openai.svg');
  assert.equal(landingIcon.status, 200);
  assert.match(landingIcon.headers.get('content-type'), /^image\/svg\+xml/);
  assert.equal((await fetch(base + '/landing-model-icons/unknown.svg')).status, 404);
  const themeStyles = await fetch(base + '/theme.css');
  assert.equal(themeStyles.status, 200);
  const themeCss = await themeStyles.text();
  assert.match(themeCss, /site-boot-orbit/);
  assert.match(themeCss, /conic-gradient/);
  assert.doesNotMatch(landingHtml, /data-boot-motion-toggle/);
  const themeScript = await fetch(base + '/theme.js');
  assert.equal(themeScript.status, 200);
  assert.match(await themeScript.text(), /ai-media-boot-motion/);
  for (const route of ['/legal/terms', '/legal/privacy', '/legal/personal-data-consent', '/legal/offer']) {
    const legal = await fetch(base + route);
    assert.equal(legal.status, 200);
    const legalHtml = await legal.text();
    assert.match(legalHtml, /AI Media Client/);
    assert.match(legalHtml, /data-theme-toggle/);
  }
  assert.equal((await fetch(base + '/legal.css')).status, 200);
  const loginHtml = await fetch(base + '/login').then(response => response.text());
  assert.match(loginHtml, /\/legal\/privacy/);
  assert.match(loginHtml, /data-theme-toggle/);
  const vueApp = await fetch(base + '/app');
  assert.equal(vueApp.status, 200);
  const vueHtml = await vueApp.text();
  assert.match(vueHtml, /<meta name="account-id" content="local">/);
  assert.match(vueHtml, /<meta name="account-role" content="admin">/);
  assert.match(vueHtml, /src="\/theme\.js"/);
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
  assert.equal(await requestStatus('/legacy'), 200);
  assert.equal(await requestStatus('/legal/terms'), 200);
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
  assert.equal(service.findModel(model.apiModel).id, model.id);
  assert.equal(service.findModel(`media:${model.apiModel}`).id, model.id);
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

test('service does not serialize independent request ids in one global enqueue chain', async t => {
  const dir = await directory();
  const service = await createMediaService({ directory: dir, provider: fakeProvider() }); t.after(() => cleanup(dir, service));
  service.queue.schedule = () => {};
  const originalEnqueue = service.queue.enqueue.bind(service.queue);
  let started = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  service.queue.enqueue = async request => { started += 1; await gate; return originalEnqueue(request); };
  const first = service.createTask({ modelId: model.id, input, requestId: 'parallel-request-1' });
  const second = service.createTask({ modelId: model.id, input, requestId: 'parallel-request-2' });
  for (let attempt = 0; attempt < 100 && started < 2; attempt += 1) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(started, 2);
  release();
  const records = await Promise.all([first, second]);
  assert.notEqual(records[0].id, records[1].id);
});

test('unconfigured service starts and refuses paid task without fabricating output', async t => {
  const dir = await directory(); const provider = fakeProvider(); provider.isConfigured = () => false;
  const service = await createMediaService({ directory: dir, provider }); t.after(() => cleanup(dir, service));
  assert.equal(service.configured(), false);
  await assert.rejects(service.createTask({ modelId: model.id, input }), /не настроен ключ/);
  assert.equal((await service.listHistory()).length, 0);
});

test('media quote falls back to a refreshed official Kie tariff when local and cached prices are missing', async t => {
  const dir = await directory(); let fetches = 0;
  const published = { modelDescription: 'bytedance/seedance-2-5, 720p with video', creditPrice: '38', creditUnit: 'per second', anchor: 'https://kie.ai/seedance-2-5', interfaceType: 'video', provider: 'ByteDance' };
  const irrelevant = { modelDescription: 'Other model', creditPrice: '1', creditUnit: 'per request', anchor: 'https://kie.ai/other-model', interfaceType: 'image', provider: 'Other' };
  const tariffFetcher = async () => ({ ok: true, async json() { return { code: 200, data: { pages: 1, records: [++fetches === 1 ? irrelevant : published] } }; } });
  const pricing = { quote() { throw new Error('Цена модели ещё не опубликована'); } };
  const service = await createMediaService({ directory: dir, provider: fakeProvider(), pricing, tariffFetcher }); t.after(() => cleanup(dir, service));
  const source = await service.saveSource({ name: 'reference.mp4', type: 'video/mp4', bytes: mp4Bytes(18.143125) });
  const quote = await service.nativeQuote('bytedance/seedance-2-5', { prompt: 'Тест', resolution: '720p', duration: 10, reference_video_urls: [source.ref] }, [{ ...source, fieldKey: 'reference_video_urls', durationSeconds: 1 }]);
  assert.equal(quote.credits, 1069.439, 'server metadata wins over forged browser duration');
  assert.equal(fetches, 2, 'a cache miss refreshes the official Kie list once');
});

test('a forced paid-submit quote warns without downloading the whole Kie list twice when a price is absent', async t => {
  const dir = await directory(); let fetches = 0;
  const tariffFetcher = async () => {
    fetches++;
    return { ok: true, async json() { return { code: 200, data: { pages: 1, records: [
      { modelDescription: 'Other model', creditPrice: '1', creditUnit: 'per request', anchor: 'https://kie.ai/other-model' },
    ] } }; } };
  };
  const service = await createMediaService({ directory: dir, provider: fakeProvider(), pricing: {}, tariffFetcher });
  t.after(() => cleanup(dir, service));
  const quote = await service.nativeQuote('bytedance/seedream', { prompt: 'A scene' }, [], true);
  assert.equal(quote.status, 'unavailable');
  assert.equal(quote.amountUnits, null);
  assert.equal(fetches, 1);
});

test('provider diagnostics checks Kie auth, live tariff and selected model without generation', async t => {
  const dir = await directory(); let created = 0, balanceChecks = 0;
  const provider = fakeProvider();
  provider.create = async () => { created++; return { taskId: 'must-not-run' }; };
  provider.balance = async () => { balanceChecks++; return 100; };
  const tariffFetcher = async () => ({ ok: true, async json() { return { code: 200, data: { pages: 1, records: [
    { modelDescription: 'Google nano banana pro, 1/2K', creditPrice: '18.0', creditUnit: 'per image', anchor: 'https://kie.ai/nano-banana-pro', interfaceType: 'image', provider: 'Google' },
    { modelDescription: 'Google nano banana pro, 4K', creditPrice: '24.0', creditUnit: 'per image', anchor: 'https://kie.ai/nano-banana-pro', interfaceType: 'image', provider: 'Google' },
  ] } }; } });
  const service = await createMediaService({ directory: dir, provider, tariffFetcher }); t.after(() => cleanup(dir, service));
  const result = await service.diagnoseProvider('nano-banana-pro', { resolution: '1K', aspect_ratio: '1:1' });
  assert.equal(result.ok, true); assert.equal(result.configured, true); assert.equal(result.quote.credits, 18);
  assert.equal(balanceChecks, 1); assert.equal(created, 0);
  assert.deepEqual(result.checks.map(item => item.step), ['configuration', 'authorization', 'tariffs', 'model-price']);
  assert.doesNotMatch(JSON.stringify(result), /Bearer\s+|test-token|secret-value/i);
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
  const conflicting = createTelegramGateway({ service, config, directory: dir, fetchImpl: async () => ({
    ok: false, status: 409, json: async () => ({ ok: false, error_code: 409, description: 'private token' })
  }) });
  await assert.rejects(conflicting.pollOnce(), error => error.code === 'TELEGRAM_POLL_CONFLICT'
    && error.message.includes('Другой экземпляр') && !error.message.includes('private token'));
});

test('config rejects external data paths and unconfigured enabled bot', () => {
  assert.throws(() => loadConfig({ MEDIA_DATA_DIR: '../outside' }), /внутри проекта/);
  assert.throws(() => loadConfig({ TELEGRAM_ENABLED: 'true' }), /TELEGRAM/);
  assert.throws(() => loadConfig({ MEDIA_STORAGE_DRIVER: 's3' }), /MEDIA_S3_ENDPOINT/);
  const storage = loadConfig({ MEDIA_STORAGE_DRIVER: 's3', MEDIA_S3_ENDPOINT: 'https://s3.example', MEDIA_S3_BUCKET: 'media', MEDIA_S3_ACCESS_KEY: 'key', MEDIA_S3_SECRET_KEY: 'secret' }).storage;
  assert.deepEqual(storage, { enabled: true, driver: 's3', endpoint: 'https://s3.example', bucket: 'media', region: 'ru-1', accessKey: 'key', secretKey: 'secret', forcePathStyle: true });
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
