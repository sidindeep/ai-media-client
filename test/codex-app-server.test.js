const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createCodexAppServer, threadParams } = require('../src/services/codex-app-server');
const { createCodexWorker } = require('../src/services/codex-worker');
const request = (prompt = 'test') => ({ requestId: randomUUID(), prompt, model: 'gpt-5.5', effort: 'medium', speed: 'standard', kind: 'text' });

async function harness(t, handler, options = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'media-app-test-'));
  const calls = [], children = [];
  const launch = (command, args, settings) => {
    assert.equal(command, 'codex'); assert.equal(args[0], 'app-server');
    assert.equal(settings.env.DATABASE_URL, undefined);
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { if (!child.killed) { child.killed = true; queueMicrotask(() => child.emit('close', 0)); } };
    const emit = value => child.stdout.write(JSON.stringify(value) + '\n');
    const reply = (m, result) => emit({ id: m.id, result });
    child.stdin = new Writable({ write(data, encoding, callback) {
      const m = JSON.parse(data.toString()); calls.push(m);
      queueMicrotask(() => {
        if (options.intercept?.({ m, emit, reply, child })) return;
        if (m.method === 'initialize') reply(m, {});
        else if (m.method === 'thread/start') reply(m, { thread: { id: randomUUID() } });
        else if (m.method === 'thread/unsubscribe' || m.method === 'turn/interrupt') reply(m, {});
        else handler?.({ m, emit, reply, child });
      });
      callback();
    } });
    children.push(child); return child;
  };
  const adapter = createCodexAppServer({ environment: () => ({ CODEX_HOME: home }), launch, ...options });
  t.after(async () => { adapter.close(); await new Promise(resolve => setImmediate(resolve)); await fs.rm(home, { recursive: true, force: true }); });
  return { adapter, children, calls, home };
}

function complete({ m, emit, reply }, text = m.params.input[0].text) {
  const threadId = m.params.threadId, turnId = randomUUID();
  // Deliberately emit before the response, as a fast server may do.
  emit({ method: 'item/completed', params: { threadId, turnId, item: { id: randomUUID(), type: 'agentMessage', text } } });
  emit({ method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: { total: { inputTokens: 10, outputTokens: 3, cachedInputTokens: 4, reasoningOutputTokens: 1 } } } });
  emit({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
  reply(m, { turn: { id: turnId } });
}

test('App-server multiplexes threads, handles notifications before RPC response and releases subscriptions', async t => {
  const h = await harness(t, data => { if (data.m.method === 'turn/start') complete(data); });
  const results = await Promise.all(['one', 'two', 'three'].map(text => h.adapter.run(request(text))));
  assert.equal(h.children.length, 1);
  assert.equal(h.calls.filter(m => m.method === 'initialize').length, 1);
  results.forEach((result, i) => { assert.ok(result.output.endsWith(['one', 'two', 'three'][i])); assert.equal(result.usage.total_tokens, 13); });
  assert.equal(new Set(h.calls.filter(m => m.method === 'turn/start').map(m => m.params.threadId)).size, 3);
  assert.equal(h.calls.filter(m => m.method === 'thread/unsubscribe').length, 3);
  assert.equal(h.adapter.status().active, 0);
});

test('App-server startup failure is unknown, does not replay, and a new request can start a new process', async t => {
  let fail = true;
  const h = await harness(t, data => { if (data.m.method === 'turn/start') { if (fail) data.child.kill(); else complete(data, 'OK'); } });
  await assert.rejects(h.adapter.run(request()), e => e.outcomeUnknown === true);
  assert.equal(h.calls.filter(m => m.method === 'turn/start').length, 1);
  fail = false;
  assert.equal((await h.adapter.run(request())).output, 'OK');
  assert.equal(h.children.length, 2);
});

test('App-server timeout interrupts only its own turn and preserves the shared process', async t => {
  const h = await harness(t, ({ m, emit, reply }) => {
    if (m.method === 'turn/start') {
      const id = randomUUID();
      emit({ method: 'turn/started', params: { threadId: m.params.threadId, turn: { id } } });
      reply(m, { turn: { id } });
    }
  }, { textTimeoutMs: 40 });
  await assert.rejects(h.adapter.run(request()), e => e.outcomeUnknown === true);
  assert.equal(h.calls.filter(m => m.method === 'turn/interrupt').length, 1);
  assert.equal(h.calls.filter(m => m.method === 'thread/unsubscribe').length, 1);
  assert.equal(h.adapter.status().active, 0);
});

test('RPC timeout is isolated; late turn acknowledgement interrupts only the timed-out turn', async t => {
  let delayed;
  const events = [];
  const h = await harness(t, data => {
    if (data.m.method !== 'turn/start') return;
    if (data.m.params.input[0].text.endsWith('slow')) delayed = data;
    else complete(data, 'healthy');
  }, { rpcTimeoutMs: 30, diagnostic: event => events.push(event) });
  const results = await Promise.allSettled([h.adapter.run(request('slow')), h.adapter.run(request('fast'))]);
  assert.equal(results[0].reason.outcomeUnknown, true);
  assert.equal(results[1].value.output, 'healthy');
  assert.equal(h.children[0].killed, undefined);
  const turnId = randomUUID(); delayed.reply(delayed.m, { turn: { id: turnId } });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(h.calls.some(m => m.method === 'turn/interrupt' && m.params.turnId === turnId));
  assert.equal((await h.adapter.run(request('next'))).output, 'healthy');
  assert.equal(h.children.length, 1);
  assert.ok(events.some(e => e.event === 'rpc_timeout' && e.method === 'turn/start'));
});

test('Generation deadline before turn acknowledgement never kills other turns', async t => {
  let delayed;
  const h = await harness(t, data => {
    if (data.m.method === 'turn/start') delayed = data;
  }, { rpcTimeoutMs: 200, textTimeoutMs: 30 });
  await assert.rejects(h.adapter.run(request()), e => e.outcomeUnknown);
  assert.equal(h.children[0].killed, undefined);
  const turnId = randomUUID(); delayed.reply(delayed.m, { turn: { id: turnId } });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(h.calls.some(m => m.method === 'turn/interrupt' && m.params.turnId === turnId));
  assert.equal(h.adapter.status().active, 0);
});

test('Late thread creation is unsubscribed and never starts a generation', async t => {
  let delayed;
  const h = await harness(t, null, { rpcTimeoutMs: 30, diagnostic: () => {}, intercept(data) {
    if (data.m.method === 'thread/start') { delayed = data; return true; }
  } });
  await assert.rejects(h.adapter.run(request()), e => e.outcomeUnknown);
  const threadId = randomUUID(); delayed.reply(delayed.m, { thread: { id: threadId } });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(h.calls.some(m => m.method === 'thread/unsubscribe' && m.params.threadId === threadId));
  assert.equal(h.calls.filter(m => m.method === 'turn/start').length, 0);
  assert.equal(h.children[0].killed, undefined);
});

test('Unsubscribe timeout preserves successful result and shared process', async t => {
  const h = await harness(t, data => { if (data.m.method === 'turn/start') complete(data, 'OK'); }, {
    rpcTimeoutMs: 30, diagnostic: () => {}, intercept: ({ m }) => m.method === 'thread/unsubscribe',
  });
  assert.equal((await h.adapter.run(request())).output, 'OK');
  assert.equal(h.children[0].killed, undefined);
  assert.equal((await h.adapter.run(request())).output, 'OK');
  assert.equal(h.children.length, 1);
});

test('App-server returns only trusted thread PNG, rejects missing image and never uses model paths', async t => {
  let collected;
  const h = await harness(t, data => { if (data.m.method === 'turn/start') complete(data, '/etc/auth.json'); }, {
    collect: async (home, id) => { collected = id; throw new Error('PNG missing'); },
  });
  await assert.rejects(h.adapter.run({ ...request(), kind: 'image' }), /PNG missing/);
  assert.equal(collected, h.calls.find(m => m.method === 'turn/start').params.threadId);
});

test('App-server accepts inline imageGeneration PNG results', async t => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const h = await harness(t, ({ m, emit, reply }) => {
    if (m.method !== 'turn/start') return;
    const threadId = m.params.threadId, turnId = randomUUID();
    emit({ method: 'item/completed', params: { threadId, turnId,
      item: { id: randomUUID(), type: 'imageGeneration', status: 'completed', result: png.toString('base64') } } });
    emit({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
    reply(m, { turn: { id: turnId } });
  }, { collect: async () => { throw new Error('inline result should avoid directory collection'); } });
  const result = await h.adapter.run({ ...request(), kind: 'image' });
  assert.deepEqual(Buffer.from(result.imageBase64, 'base64'), png);
});

test('App-server sends source images with the v2 UserInput url field', async t => {
  let turnInput;
  const source = 'data:image/png;base64,iVBORw0KGgo=';
  const h = await harness(t, data => {
    if (data.m.method !== 'turn/start') return;
    turnInput = data.m.params.input;
    complete(data, 'edited');
  });
  await h.adapter.run({ ...request(), images: [source] });
  assert.deepEqual(turnInput[1], { type: 'image', url: source });
});

test('App-server sandbox and feature policy is per-thread, with no inherited user config', async t => {
  const text = threadParams(request(), '/tmp/work');
  const image = threadParams({ ...request(), kind: 'image', speed: 'fast' }, '/tmp/work');
  assert.equal(text.sandbox, 'read-only'); assert.equal(text.approvalPolicy, 'never');
  assert.equal(text.ephemeral, true); assert.equal(text.config['features.shell_tool'], false);
  assert.equal(text.config['features.image_generation'], false);
  assert.equal(image.config['features.image_generation'], true); assert.equal(image.serviceTier, 'fast');
  const h = await harness(t);
  await fs.writeFile(path.join(h.home, 'config.toml'), '[mcp_servers.untrusted]\ncommand="bad"');
  await assert.rejects(h.adapter.run(request()), /config.toml/);
  assert.equal(h.children.length, 0);
});

test('App-server returns PNG and removes the collected temporary directory', async t => {
  let directory;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const h = await harness(t, data => { if (data.m.method === 'turn/start') complete(data); }, {
    collect: async home => { directory = await fs.mkdtemp(path.join(home, 'image-')); return { buffer: png, directory }; },
  });
  const result = await h.adapter.run({ ...request(), kind: 'image' });
  assert.deepEqual(Buffer.from(result.imageBase64, 'base64'), png);
  assert.equal(await fs.stat(directory).then(() => true, () => false), false);
});

test('Closing app-server rejects all in-flight requests without spawning replacements', async t => {
  let turnCount = 0, ready;
  const started = new Promise(resolve => { ready = resolve; });
  const h = await harness(t, ({ m, reply }) => {
    if (m.method === 'turn/start') { reply(m, { turn: { id: randomUUID() } }); if (++turnCount === 2) ready(); }
  });
  const runs = Promise.allSettled([h.adapter.run(request()), h.adapter.run(request())]);
  await started; h.adapter.close();
  for (const result of await runs) { assert.equal(result.status, 'rejected'); assert.equal(result.reason.outcomeUnknown, true); }
  await assert.rejects(h.adapter.run(request())); assert.equal(h.children.length, 1);
});

test('Worker retains unknown outcome and deduplicates without running another adapter call', async t => {
  let runs = 0;
  const server = createCodexWorker(async () => { runs++; throw Object.assign(new Error('Unknown'), { outcomeUnknown: true }); }, { transport: 'app-server' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const job = request(), headers = { 'x-account-id': randomUUID() };
  await fetch(base + '/jobs', { method: 'POST', headers, body: JSON.stringify(job) });
  const second = await fetch(base + '/jobs', { method: 'POST', headers, body: JSON.stringify(job) }).then(r => r.json());
  assert.equal(second.state, 'unknown'); assert.equal(runs, 1);
  assert.equal((await fetch(base + '/health').then(r => r.json())).transport, 'app-server');
  assert.throws(() => createCodexWorker(undefined, { transport: 'invalid' }), /MEDIA_CODEX_TRANSPORT/);
});
