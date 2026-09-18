const test = require('node:test');
const assert = require('node:assert/strict');
const { createCodexAppServerPool } = require('../src/services/codex-app-server-pool');

function harness(size = 2, concurrency = 1) {
  const calls = [], adapters = [];
  const pool = createCodexAppServerPool({ size, concurrency, createAdapter() {
    const id = adapters.length;
    const pending = new Set();
    const adapter = {
      run(request) { return new Promise((resolve, reject) => {
        const call = { id, request, resolve: value => { pending.delete(call); resolve(value); },
          reject: error => { pending.delete(call); reject(error); } };
        pending.add(call); calls.push(call);
      }); },
      close() { for (const call of pending) call.reject(Object.assign(new Error('Lost'), { outcomeUnknown: true })); },
      status() { return { running: pending.size > 0 }; },
    };
    adapters.push(adapter); return adapter;
  } });
  return { pool, calls, adapters };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('Pool distributes 256 requests as 128 per process and queues overflow', async () => {
  const h = harness(2, 128);
  const result = Promise.all(Array.from({ length: 257 }, (_, id) => h.pool.run(id)));
  await tick();
  assert.deepEqual(h.pool.status().processes.map(p => p.active), [128, 128]);
  assert.equal(h.pool.status().queued, 1);
  h.calls[0].resolve('ok'); await tick();
  assert.equal(h.calls.length, 257); assert.equal(h.calls[256].id, 0);
  for (const call of h.calls.slice(1)) call.resolve('ok');
  assert.equal((await result).length, 257); await tick();
  assert.equal(h.pool.status().active, 0); h.pool.close();
});

test('Failure in one process does not replay requests or fail the other process', async () => {
  const h = harness();
  const result = Promise.allSettled([h.pool.run('a'), h.pool.run('b')]);
  await tick(); h.adapters[0].close(); h.calls[1].resolve('ok');
  const outcomes = await result;
  assert.equal(outcomes[0].reason.outcomeUnknown, true);
  assert.equal(outcomes[1].value, 'ok'); assert.equal(h.calls.length, 2); h.pool.close();
});

test('Queued cancellation never reaches provider; shutdown rejects queued and active work', async () => {
  const h = harness(1, 1), controller = new AbortController();
  const result = Promise.allSettled([h.pool.run('active'), h.pool.run('cancel', { signal: controller.signal }), h.pool.run('queued')]);
  await tick(); controller.abort(); assert.equal(h.pool.status().queued, 1);
  h.pool.close(); const outcomes = await result;
  assert.equal(outcomes[0].reason.outcomeUnknown, true);
  assert.equal(outcomes[1].reason.outcomeUnknown, undefined);
  assert.equal(outcomes[2].reason.outcomeUnknown, undefined);
  assert.equal(h.calls.length, 1); await assert.rejects(h.pool.run('closed'));
});
