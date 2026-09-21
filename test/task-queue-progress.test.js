const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TaskQueue } = require('../src/task-queue');

class Store {
  constructor() { this.rows = []; }
  async list() { return structuredClone(this.rows); }
  async update(id, changes, expected) {
    const index = this.rows.findIndex(row => row.id === id);
    if (expected && !expected.includes(this.rows[index]?.state)) throw new Error('Changed');
    const row = { ...(this.rows[index] || { id }), ...structuredClone(changes) };
    if (index < 0) this.rows.unshift(row); else this.rows[index] = row;
    return structuredClone(row);
  }
}

test('queue records user-visible Kie stages and checks status every two seconds by default', async () => {
  const store = new Store();
  const queue = new TaskQueue({
    store,
    prepare: async record => record.input,
    create: async () => ({ taskId: 'provider-task' }),
    poll: async () => ({ state: 'success', progress: 100, providerDurationMs: 1200 }),
  });
  queue.schedule = () => {};
  assert.equal(queue.interval, 2000);

  const task = await queue.enqueue({ input: { prompt: 'котик' } });
  queue.start();
  await queue.tick();
  const accepted = (await store.list()).find(row => row.id === task.id);
  assert.equal(accepted.state, 'waiting');
  for (const field of ['queuedAt', 'preparingAt', 'submittingAt', 'providerAcceptedAt']) assert.match(accepted[field], /T/);

  await queue.tick();
  const completed = (await store.list()).find(row => row.id === task.id);
  assert.equal(completed.state, 'success');
  for (const field of ['providerFirstCheckedAt', 'lastCheckedAt', 'providerStateChangedAt', 'resultReceivedAt', 'generationCompletedAt']) assert.match(completed[field], /T/);
  assert.equal(completed.providerDurationMs, 1200);
  queue.close();
});
