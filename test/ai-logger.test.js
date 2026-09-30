const test = require('node:test');
const assert = require('node:assert/strict');
const { createForwarder } = require('../src/ai-logger');

test('central logger forwards only selected diagnostic metadata', async () => {
  const records = [];
  const forwarder = createForwarder({
    env: {
      AI_LOGGER_PROJECT: 'ai-media-client', AI_LOGGER_SERVER_URL: 'http://127.0.0.1:8766/ingest',
      MEDIA_REPLICA_ROLE: 'executor',
    },
    fetchImpl: async (_url, options) => {
      records.push(JSON.parse(options.body));
      return { ok: true };
    },
  });

  forwarder.lifecycle('task.enqueued');
  forwarder.systemError({
    source: 'provider', event: 'request.failed', code: 'UPSTREAM_TIMEOUT',
    message: 'private prompt', details: { token: 'private key', accountId: 'private account' },
  });
  await forwarder.flush();
  assert.equal(records.length, 2);
  assert.equal(records[0].message, 'task.enqueued');
  assert.equal(records[1].message, 'request.failed');
  assert.equal(records[1].level, 'ERROR');
  assert.equal(records[1].context.project, 'ai-media-client');
  assert.equal(records[1].context.service, 'executor');
  assert.equal(records[1].context.error_code, 'UPSTREAM_TIMEOUT');
  assert.ok(!JSON.stringify(records).includes('private'));
});

test('central logger leaves application flow unaffected when delivery fails', async () => {
  const forwarder = createForwarder({
    env: { AI_LOGGER_PROJECT: 'ai-media-client', AI_LOGGER_SERVER_URL: 'http://127.0.0.1:8766/ingest' },
    fetchImpl: async () => { throw new Error('offline'); },
  });
  forwarder.systemError({ source: 'server', event: 'startup.error' });
  await forwarder.flush();
  assert.equal(forwarder.status().pending, 1);
  await forwarder.close();
});

test('central recorder bounds outage queues, retries and stops after close', async () => {
  let offline = true;
  const records = [];
  const forwarder = createForwarder({
    env: { AI_LOGGER_PROJECT: 'ai-media-client', AI_LOGGER_SERVER_URL: 'https://logger.example/ingest' },
    maxPending: 2, retryMs: 10,
    fetchImpl: async (_url, options) => {
      if (offline) throw new Error('offline');
      records.push(JSON.parse(options.body));
      return { ok: true };
    },
  });
  forwarder.systemError({ source: 'server', event: 'first.error' });
  await forwarder.flush();
  forwarder.systemError({ source: 'server', event: 'second.error' });
  forwarder.systemError({ source: 'server', event: 'third.error' });
  await forwarder.flush();
  assert.equal(forwarder.status().pending, 2);
  assert.equal(forwarder.status().dropped, 1);
  offline = false;
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(records.map(row => row.message), ['second.error', 'third.error']);
  assert.equal(forwarder.status().pending, 0);
  await forwarder.close();
  forwarder.systemError({ source: 'server', event: 'after.close' });
  assert.equal(records.length, 2);
});

test('project and instance are automatic without manual identity configuration', async () => {
  const { hostname } = require('node:os');
  const { resolveIdentity } = require('../src/ai-logger/identity');
  const { AiLoggerClient } = await import('../src/ai-logger/client.mjs');
  const records = [];
  const env = { AI_LOGGER_SERVER_URL: 'https://logger.example/ingest' };
  const forwarder = createForwarder({ env, fetchImpl: async (_, options) => {
    records.push(JSON.parse(options.body)); return { ok: true };
  } });
  forwarder.systemError({ source: 'startup', event: 'startup.error', error: new Error('Startup failed') });
  await forwarder.flush(); await forwarder.close();
  assert.equal(records[0].context.project, 'ai-media-client');
  assert.equal(records[0].context.instance_id, `${hostname()}:${process.pid}`);
  assert.deepEqual(resolveIdentity({ AI_LOGGER_PROJECT: ' ', AI_LOGGER_INSTANCE_ID: '' }),
    { project: 'ai-media-client', instanceId: `${hostname()}:${process.pid}` });
  assert.deepEqual(resolveIdentity({ AI_LOGGER_PROJECT: 'legacy-project', AI_LOGGER_INSTANCE_ID: 'shared-machine' }),
    resolveIdentity());
  const client = AiLoggerClient.fromEnv(env);
  assert.equal(client.project, records[0].context.project);
  assert.equal(client.instanceId, records[0].context.instance_id);
  assert.equal(createForwarder({ env: {} }), null);
});

test('separate replica processes automatically have distinct instance identities', () => {
  const { spawnSync } = require('node:child_process');
  const modulePath = require.resolve('../src/ai-logger/identity');
  const code = `process.stdout.write(JSON.stringify(require(${JSON.stringify(modulePath)}).resolveIdentity()))`;
  const identities = Array.from({ length: 2 }, () => {
    const child = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8',
      env: { ...process.env, AI_LOGGER_INSTANCE_ID: 'same-legacy-id', AI_LOGGER_PROJECT: 'legacy-project' } });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  });
  assert.equal(identities[0].project, 'ai-media-client');
  assert.equal(identities[1].project, 'ai-media-client');
  assert.notEqual(identities[0].instanceId, identities[1].instanceId);
  assert.notEqual(identities[0].instanceId, 'same-legacy-id');
});

test('private LAN HTTP requires an explicit opt-in', async () => {
  const { AiLoggerClient } = await import('../src/ai-logger/client.mjs');
  assert.throws(() => new AiLoggerClient({
    serverUrl: 'http://192.168.3.63:8765/ingest', project: 'ai-media-client',
  }), /HTTPS is required/);
  assert.doesNotThrow(() => new AiLoggerClient({
    serverUrl: 'http://192.168.3.63:8765/ingest', project: 'ai-media-client',
    allowPrivateHttp: true,
  }));
  assert.throws(() => new AiLoggerClient({
    serverUrl: 'http://logger.example/ingest', project: 'ai-media-client',
    allowPrivateHttp: true,
  }), /HTTPS is required/);
});


test('original Error reaches HTTP with diagnostics, machine ID and secret exclusion', async t => {
  const { record } = require('../src/system-errors');
  const logger = require('../src/ai-logger');
  const { sanitizer } = require('../src/ai-logger/diagnostics');
  const records = [];
  const forwarder = createForwarder({ env: { AI_LOGGER_PROJECT: 'ai-media-client',
    AI_LOGGER_SERVER_URL: 'https://logger.example/ingest', AI_LOGGER_INSTANCE_ID: 'persistent-machine',
    AI_LOGGER_SERVICE: 'executor' }, fetchImpl: async (_, options) => {
      records.push(JSON.parse(options.body)); return { ok: true };
    } });
  t.after(() => forwarder.close());
  const original = logger.reportSystemError;
  logger.reportSystemError = row => forwarder.systemError(row);
  t.after(() => { logger.reportSystemError = original; });
  sanitizer.secret('registered-private-key');
  const failure = Object.assign(new TypeError('Request failed; token=token-fixture; Cookie=session-fixture; prompt="prompt fixture"; accountId=account-fixture; user@example.test; registered-private-key; https://user:pass@example.test/job?key=query-fixture'), { code: 'PROVIDER_FAILED' });
  const stack = failure.stack;
  record('provider', 'request.failed', failure, { diagnostic: { description: 'Provider request failed', entity: 'provider' },
    details: { prompt: 'arbitrary prompt', rawResponse: 'private payload', accountId: 'owner-private' } });
  await forwarder.flush();
  assert.equal(failure.stack, stack);
  const row = records[0];
  assert.equal(row.message, 'request.failed');
  assert.equal(row.context.error_code, 'PROVIDER_FAILED');
  assert.equal(row.context.description, 'Provider request failed');
  assert.equal(row.context.entity, 'provider');
  assert.match(row.context.file, /ai-logger.test.js$/);
  assert.ok(Number(row.context.line) > 0);
  assert.match(row.exception.stack_trace, /ai-logger.test.js:\d+:\d+/);
  assert.equal(row.exception.type, 'TypeError');
  assert.equal(row.context.instance_id, require('../src/ai-logger/identity').resolveIdentity().instanceId);
  assert.equal(row.context.service, 'executor');
  for (const forbidden of ['token-fixture', 'session-fixture', 'prompt fixture', 'account-fixture', 'user@example.test',
    'registered-private-key', 'query-fixture', 'user:pass', 'arbitrary prompt', 'private payload', 'owner-private'])
    assert.ok(!JSON.stringify(row).includes(forbidden), forbidden);
});

test('batch rows retain selected exception and diagnostic; process identity survives role changes', async () => {
  const records = [];
  for (const service of ['web', 'executor', 'web']) {
    const forwarder = createForwarder({ env: { AI_LOGGER_PROJECT: 'ai-media-client',
      AI_LOGGER_SERVER_URL: 'https://logger.example/ingest', AI_LOGGER_INSTANCE_ID: 'same-machine', AI_LOGGER_SERVICE: service },
      fetchImpl: async (_, options) => { records.push(JSON.parse(options.body)); return { ok: true }; } });
    forwarder.systemError({ source: 'worker', event: 'batch.error', code: 'BATCH_FAILED',
      exception: { type: 'RangeError', message: 'Out of range', stack_trace: 'RangeError: Out of range\n    at execute (/app/worker.js:42:3)' },
      diagnostic: { description: 'Batch failed', entity: 'task', file: '/app/worker.js', line: 42, function: 'execute', prompt: 'excluded' },
      details: { token: 'excluded' } });
    await forwarder.flush(); await forwarder.close();
  }
  assert.deepEqual(records.map(row => row.context.instance_id), Array(3).fill(require('../src/ai-logger/identity').resolveIdentity().instanceId));
  assert.deepEqual(records.map(row => row.context.service), ['web', 'executor', 'web']);
  assert.equal(records[0].context.function, 'execute');
  assert.equal(records[0].context.line, '42');
  assert.match(records[0].exception.stack_trace, /worker.js:42:3/);
  assert.ok(!JSON.stringify(records).includes('excluded'));
});

test('missing stack never produces an invented location or exception', async () => {
  const records = [];
  const forwarder = createForwarder({ env: { AI_LOGGER_PROJECT: 'ai-media-client', AI_LOGGER_SERVER_URL: 'https://logger.example/ingest' },
    fetchImpl: async (_, options) => { records.push(JSON.parse(options.body)); return { ok: true }; } });
  const { diagnostic } = require('../src/ai-logger/diagnostics');
  forwarder.systemError({ source: 'provider', event: 'kie.fail', code: '500', diagnostic: diagnostic('provider', 'kie.fail', { code: '500' }) });
  await forwarder.flush(); await forwarder.close();
  assert.equal(records[0].exception, undefined);
  for (const key of ['file', 'line', 'function']) assert.equal(records[0].context[key], undefined);
});

test('console capture delivers string diagnostics and original errors without console payloads', async t => {
  const errors = require('../src/system-errors');
  const logger = require('../src/ai-logger');
  const { sanitizer } = require('../src/ai-logger/diagnostics');
  sanitizer.secret('console-private-secret');
  const records = [], calls = [];
  const forwarder = createForwarder({ env: { AI_LOGGER_PROJECT: 'ai-media-client',
    AI_LOGGER_SERVER_URL: 'https://logger.example/ingest', AI_LOGGER_INSTANCE_ID: 'console-machine' },
    fetchImpl: async (_, options) => { records.push(JSON.parse(options.body)); return { ok: true }; } });
  const original = logger.reportSystemError;
  logger.reportSystemError = row => forwarder.systemError(row);
  const target = { error(...args) { calls.push(args); } };
  const restore = errors.captureConsole(target);
  t.after(async () => { restore(); logger.reportSystemError = original; await forwarder.close(); });
  const payload = { rawResponse: 'DO_NOT_SEND_RESPONSE', prompt: 'DO_NOT_SEND_PROMPT' };
  payload.self = payload;
  const failure = Object.assign(new TypeError('Connection failed console-private-secret'), { code: 'ECONNRESET' });
  const stack = failure.stack;
  target.error('Service unavailable:', payload, failure);
  target.error('Cleanup failed:', 'console-private-secret', 'token=console-token-fixture');
  target.error('{"rawResponse":"DO_NOT_SEND_JSON"}', payload);
  await forwarder.flush();
  assert.equal(records.length, 3);
  assert.equal(calls[0][1], payload);
  assert.equal(calls[0][2], failure);
  assert.equal(failure.stack, stack);
  assert.equal(records[0].context.error_code, 'ECONNRESET');
  assert.equal(records[0].context.description, 'Service unavailable:');
  assert.equal(records[0].context.instance_id, require('../src/ai-logger/identity').resolveIdentity().instanceId);
  assert.equal(records[0].exception.type, 'TypeError');
  assert.match(records[0].exception.stack_trace, /ai-logger.test.js:\d+:\d+/);
  assert.match(records[0].context.file, /ai-logger.test.js$/);
  assert.match(records[1].context.description, /Cleanup failed:/);
  assert.equal(records[1].exception, undefined);
  assert.equal(records[1].context.file, undefined);
  assert.equal(records[2].context.description, '[REDACTED PAYLOAD]');
  for (const forbidden of ['console-private-secret', 'console-token-fixture', 'DO_NOT_SEND_'])
    assert.ok(!JSON.stringify(records).includes(forbidden), forbidden);
});


test('provider connection capture receives the original failure before user-facing conversion', async t => {
  const errors = require('../src/system-errors');
  const captured = []; const original = errors.record;
  errors.record = (source, event, error) => captured.push({ source, event, error });
  t.after(() => { errors.record = original; });
  const failure = Object.assign(new Error('Transport failed'), { code: 'ECONNRESET' });
  const stack = failure.stack;
  const router = require('../src/providers/routerai/client').createRouterAiClient({ apiKey: 'fixture-key', fetchImpl: async () => { throw failure; } });
  const apimart = require('../src/providers/apimart/client').createApimartClient({ apiKey: 'fixture-key', fetchImpl: async () => { throw failure; } });
  await assert.rejects(router.credits(), /Transport failed/);
  await assert.rejects(apimart.balance(), /Transport failed/);
  assert.deepEqual(captured.map(row => row.event), ['routerai.connection.error', 'apimart.connection.error']);
  assert.ok(captured.every(row => row.error === failure && row.error.stack === stack));
});
