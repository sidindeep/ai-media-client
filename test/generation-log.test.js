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
  const events = [], original = aiLogger.reportEvent;
  aiLogger.reportEvent = (source, event) => events.push({ source, event, context: trace.current() });
  t.after(() => { aiLogger.reportEvent = original; });
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
  for (const event of ['session.start', 'task.enqueued', 'task.prepare.start', 'task.prepare.success', 'task.create.success', 'task.poll.start', 'http.request', 'http.response', 'task.status'])
    assert.ok(events.some(row => row.event === event), event);
  assert.ok(events.filter(row => row.context?.jobId === job.id).every(row => row.context.requestId === job.traceRequestId));
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
