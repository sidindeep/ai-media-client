const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const aiLogger = require('../src/ai-logger');
const trace = require('../src/generation-log');
const { History } = require('../src/history');
const { TaskQueue } = require('../src/task-queue');

test('generation diagnostics go centrally without disk logs or payloads; owner task retains failures', async t => {
  const base = path.resolve(__dirname, '../artifacts'); await fs.mkdir(base, { recursive: true });
  const directory = await fs.mkdtemp(path.join(base, 'trace-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const events = [], original = aiLogger.reportEvent, originalGeneration = aiLogger.reportGenerationEvent;
  aiLogger.reportEvent = (source, event) => events.push({ source, event, context: trace.current() });
  aiLogger.reportGenerationEvent = (event, provider, record) => events.push({ source: 'generation', event,
    context: require('../src/ai-logger/events').generationMetadata(provider, record) });
  t.after(() => { aiLogger.reportEvent = original; aiLogger.reportGenerationEvent = originalGeneration; });
  trace.configure(path.join(directory, 'logs'));
  const store = new History(path.join(directory, 'history.json'));
  const queue = new TaskQueue({ store, interval: 100000, prepare: async row => row.input,
    create: async () => ({ taskId: 'remote-timeout' }),
    poll: async () => {
      const response = await trace.tracedFetch('https://api.example.test/status?token=signed-secret',
        { headers: { Authorization: 'Bearer key-secret-test' } }, async () => new Response(JSON.stringify({
          data: { state: 'fail', failCode: '524', failMsg: 'generate task timeout.', token: 'body-secret' },
        }), { headers: { 'content-type': 'application/json' } }));
      return (await response.json()).data;
    },
  });
  t.after(() => queue.close());
  const job = await trace.request(() => queue.enqueue({ model: 'nano-banana-pro', input: { prompt: 'private prompt', image_input: [] } }));
  queue.start(); await queue.tick(); await queue.pollTick(); queue.close();
  await trace.flush();
  assert.deepEqual(events.map(row => row.event), ['generation.started', 'generation.completed']);
  assert.ok(events.every(row => row.context.job_id === job.id && row.context.provider === 'kie'));
  assert.equal(events[1].context.status, 'fail');
  const ownerRecord = (await store.list())[0];
  assert.equal(ownerRecord.state, 'fail');
  assert.equal(ownerRecord.failMsg, 'generate task timeout.');
  assert.ok(!JSON.stringify(events).includes('private prompt'));
  await assert.rejects(fs.stat(path.join(directory, 'logs')), { code: 'ENOENT' });
});

test('diagnostics do not read provider bodies and preserve the caller response stream', async () => {
  const response = new Response('private provider payload');
  assert.equal(await trace.tracedFetch('https://example.test', {}, async () => response), response);
  assert.equal(response.bodyUsed, false);
});

test('successful polling and account timings send no HTTP logs while lifecycle and intermediate failures survive', async t => {
  const saved = [];
  const forwarder = aiLogger.createForwarder({ env: { AI_LOGGER_SERVER_URL: 'https://logger.example/ingest' },
    fetchImpl: async (_, options) => { saved.push(JSON.parse(options.body)); return { ok: true }; } });
  const original = aiLogger.reportEvent, originalError = aiLogger.reportSystemError;
  aiLogger.reportEvent = (...args) => forwarder.event(...args);
  aiLogger.reportSystemError = row => forwarder.systemError(row);
  t.after(async () => { aiLogger.reportEvent = original; aiLogger.reportSystemError = originalError; await forwarder.close(); });
  const id = require('node:crypto').randomUUID();
  forwarder.generation('generation.started', 'kie', { id, state: 'submitting', prompt: 'DO_NOT_SEND_PROMPT' });
  for (let index = 0; index < 50; index++) {
    trace.timing('generation.account_service', { cold: false, elapsedMs: 1 });
    await trace.step('task.poll', {}, () => trace.tracedFetch('https://provider.example/status', {}, async () => new Response('DO_NOT_SEND_BODY')));
    trace.write('task.status', { state: 'generating' });
    forwarder.event('studio', 'chat.sync.loaded');
    forwarder.event('startup', 'runtime.ready');
    forwarder.lifecycle('queue.recover');
  }
  await trace.flush(); await forwarder.flush();
  assert.deepEqual(saved.map(row => row.message), ['generation.started']);
  const failure = Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' });
  await assert.rejects(trace.step('task.poll', {}, async () => { throw failure; }), error => error === failure);
  await trace.tracedFetch('https://provider.example/status', {}, async () => new Response('', { status: 503 }));
  forwarder.generation('generation.completed', 'kie', { id, state: 'success', prompt: 'DO_NOT_SEND_PROMPT' });
  await forwarder.flush();
  assert.deepEqual(saved.map(row => [row.message, row.level]), [
    ['generation.started', 'INFO'], ['task.poll.error', 'ERROR'],
    ['http.response.rejected', 'WARNING'], ['generation.completed', 'INFO'],
  ]);
  assert.equal(saved[1].exception.message, 'Connection reset');
  assert.equal(saved[1].context.error_code, 'ECONNRESET');
  assert.ok(!JSON.stringify(saved).includes('DO_NOT_SEND_'));
});
