const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TaskQueue } = require('../src/task-queue');

class Store {
  constructor() { this.rows = []; this.removals = []; }
  async list() { return structuredClone(this.rows); }
  async update(id, changes, expected) {
    const index = this.rows.findIndex(row => row.id === id);
    if (expected && !expected.includes(this.rows[index]?.state)) throw new Error('Changed');
    const row = { ...(this.rows[index] || { id }), ...structuredClone(changes) };
    if (index < 0) this.rows.unshift(row); else this.rows[index] = row;
    return structuredClone(row);
  }
  async remove(id, settlementState, expectedStates) {
    const index = this.rows.findIndex(row => row.id === id);
    if (index < 0) return null;
    if (expectedStates && !expectedStates.includes(this.rows[index].state)) return null;
    const [row] = this.rows.splice(index, 1);
    this.removals.push({ id, settlementState });
    return structuredClone(row);
  }
}

async function waitFor(check) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error('Condition was not reached');
}

test('queue records user-visible Kie stages and checks status every two seconds by default', async () => {
  const store = new Store();
  const queue = new TaskQueue({
    store,
    prepare: async record => record.input,
    create: async () => ({ taskId: 'provider-task' }),
    poll: async () => ({ state: 'success', progress: 100, providerDurationMs: 1200 }),
  });
  queue.schedule = () => {}; queue.schedulePoll = () => {};
  assert.equal(queue.interval, 2000);

  const task = await queue.enqueue({ input: { prompt: 'котик' } });
  queue.start();
  await queue.tick();
  const accepted = (await store.list()).find(row => row.id === task.id);
  assert.equal(accepted.state, 'waiting');
  for (const field of ['queuedAt', 'preparingAt', 'submittingAt', 'providerAcceptedAt']) assert.match(accepted[field], /T/);

  await queue.pollTick();
  const completed = (await store.list()).find(row => row.id === task.id);
  assert.equal(completed.state, 'success');
  for (const field of ['providerFirstCheckedAt', 'lastCheckedAt', 'providerStateChangedAt', 'resultReceivedAt', 'generationCompletedAt']) assert.match(completed[field], /T/);
  assert.equal(completed.providerDurationMs, 1200);
  queue.close();
});

test('queue prepares and submits every available slot concurrently', async () => {
  const store = new Store();
  let releasePreparation;
  const preparationGate = new Promise(resolve => { releasePreparation = resolve; });
  const preparing = [];
  const queue = new TaskQueue({
    store, concurrency: 3,
    prepare: async record => { preparing.push(record.id); await preparationGate; return record.input; },
    create: async record => ({ taskId: `provider-${record.id}` }),
    poll: async () => ({ state: 'waiting' }),
  });
  queue.schedule = () => {}; queue.schedulePoll = () => {};
  await Promise.all([1, 2, 3].map(number => queue.enqueue({ input: { number } })));
  queue.start();
  const running = queue.tick();
  await waitFor(() => preparing.length === 3);
  assert.equal(new Set(preparing).size, 3);
  releasePreparation();
  await running;
  assert.deepEqual((await store.list()).map(row => row.state), ['waiting', 'waiting', 'waiting']);
  queue.close();
});

test('queue polls active jobs without blocking a free submission slot', async () => {
  const store = new Store();
  store.rows = [
    { id: 'remote', state: 'waiting', taskId: 'provider-existing', input: {} },
    { id: 'queued', state: 'queued', taskId: null, input: {} },
  ];
  let releasePoll;
  const pollGate = new Promise(resolve => { releasePoll = resolve; });
  let preparationStarted = false;
  const queue = new TaskQueue({
    store, concurrency: 2,
    prepare: async record => { preparationStarted = true; return record.input; },
    create: async () => ({ taskId: 'provider-new' }),
    poll: async () => { await pollGate; return { state: 'waiting' }; },
  });
  queue.schedule = () => {}; queue.schedulePoll = () => {};
  queue.paused = false;
  const polling = queue.pollTick();
  const running = queue.tick();
  await waitFor(() => preparationStarted);
  assert.equal((await store.list()).find(row => row.id === 'queued').state !== 'queued', true);
  releasePoll();
  await Promise.all([polling, running]);
  assert.equal((await store.list()).find(row => row.id === 'queued').state, 'waiting');
  queue.close();
});

test('slow preparation cannot stop provider status polling', async () => {
  const store = new Store();
  store.rows = [
    { id: 'remote', state: 'waiting', taskId: 'provider-existing', input: {}, generationStartedAt: new Date().toISOString() },
    { id: 'queued', state: 'queued', taskId: null, input: {} },
  ];
  let releasePreparation;
  const preparationGate = new Promise(resolve => { releasePreparation = resolve; });
  const queue = new TaskQueue({
    store, concurrency: 2,
    prepare: async record => { await preparationGate; return record.input; },
    create: async () => ({ taskId: 'provider-new' }),
    poll: async () => ({ state: 'success' }),
  });
  queue.schedule = () => {}; queue.schedulePoll = () => {};
  queue.paused = false;
  const submitting = queue.tick();
  await waitFor(() => store.rows.find(row => row.id === 'queued').state === 'preparing');
  await queue.pollTick();
  assert.equal((await store.list()).find(row => row.id === 'remote').state, 'success');
  assert.equal((await store.list()).find(row => row.id === 'queued').state, 'preparing');
  releasePreparation();
  await submitting;
  queue.close();
});

test('recovery resumes safe queued work and isolates ambiguous submissions', async () => {
  const safeStore = new Store();
  safeStore.rows = [{ id: 'queued', state: 'queued', taskId: null, input: {} }];
  const safeQueue = new TaskQueue({ store: safeStore, prepare: async row => row.input, create: async () => ({ taskId: 'provider' }), poll: async () => ({ state: 'waiting' }) });
  let scheduled = false;
  safeQueue.schedule = () => { scheduled = true; }; safeQueue.schedulePoll = () => {};
  await safeQueue.recover();
  assert.equal(safeQueue.paused, false);
  assert.equal(scheduled, true);
  safeQueue.close();

  const ambiguousStore = new Store();
  ambiguousStore.rows = [{ id: 'unknown', state: 'unknown', taskId: null, input: {} }, { id: 'safe', state: 'queued', taskId: null, input: {} }];
  const ambiguousQueue = new TaskQueue({ store: ambiguousStore, prepare: async row => row.input, create: async () => ({ taskId: 'provider' }), poll: async () => ({ state: 'waiting' }) });
  let safeScheduled = false;
  ambiguousQueue.schedule = () => { safeScheduled = true; }; ambiguousQueue.schedulePoll = () => {};
  await ambiguousQueue.recover();
  assert.equal(ambiguousQueue.paused, false);
  assert.equal(safeScheduled, true);
  assert.equal((await ambiguousStore.list()).find(row => row.id === 'unknown').state, 'unknown');
  ambiguousQueue.close();
});

test('one item provider failure does not pause or rewind other items', async () => {
  const store = new Store();
  store.rows = [
    { id: 'remote', state: 'waiting', taskId: 'provider-existing', input: {} },
    { id: 'queued', state: 'queued', taskId: null, input: {} },
  ];
  const queue = new TaskQueue({ store, concurrency: 2, prepare: async row => row.input, create: async () => ({ taskId: 'provider-new' }), poll: async () => { throw new Error('temporary status failure'); } });
  queue.schedule = () => {}; queue.schedulePoll = () => {}; queue.paused = false;
  await Promise.all([queue.pollTick(), queue.tick()]);
  assert.equal((await store.list()).find(row => row.id === 'remote').state, 'waiting');
  assert.match((await store.list()).find(row => row.id === 'remote').statusError, /temporary/);
  assert.equal((await store.list()).find(row => row.id === 'queued').state, 'waiting');
  assert.equal(queue.paused, false);
  queue.close();
});

test('one item preparation failure is blocked without pausing sibling items', async () => {
  const store = new Store();
  const queue = new TaskQueue({ store, concurrency: 2,
    prepare: async row => { if (row.input.fail) throw new Error('bad source'); return row.input; },
    create: async row => ({ taskId: `provider-${row.id}` }), poll: async () => ({ state: 'waiting' }) });
  queue.schedule = () => {}; queue.schedulePoll = () => {};
  await queue.enqueue({ input: { ok: true } });
  await queue.enqueue({ input: { fail: true } });
  queue.start(); await queue.tick();
  const states = (await store.list()).map(row => row.state).sort();
  assert.deepEqual(states, ['blocked', 'waiting']);
  assert.equal(queue.paused, false);
  queue.close();
});

test('pause never rewinds an item that already owns a preparation slot', async () => {
  const store = new Store(); let release;
  const gate = new Promise(resolve => { release = resolve; });
  const queue = new TaskQueue({ store, prepare: async row => { await gate; return row.input; }, create: async () => ({ taskId: 'provider' }), poll: async () => ({ state: 'waiting' }) });
  queue.schedule = () => {}; queue.schedulePoll = () => {};
  await queue.enqueue({ input: {} }); queue.start();
  const running = queue.tick();
  await waitFor(() => store.rows[0].state === 'preparing');
  queue.pause(); release(); await running;
  assert.equal(store.rows[0].state, 'waiting');
  assert.equal(queue.paused, true);
  queue.close();
});

test('removing an unsent item deletes it and prevents a preparation race from recreating it', async () => {
  const store = new Store(); let release;
  const gate = new Promise(resolve => { release = resolve; });
  const queue = new TaskQueue({ store, prepare: async row => { await gate; return row.input; }, create: async () => ({ taskId: 'provider' }), poll: async () => ({ state: 'waiting' }) });
  queue.schedule = () => {}; queue.schedulePoll = () => {};
  const item = await queue.enqueue({ input: {} }); queue.start();
  const running = queue.tick(); await waitFor(() => store.rows[0]?.state === 'preparing');
  assert.deepEqual(await queue.remove(item.id), { removed: true, providerMayHaveCharged: false });
  release(); await running;
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(store.removals, [{ id: item.id, settlementState: 'cancelled' }]);
  queue.close();
});

test('clearing deletes every queue item, preserves completed history and marks submitted work as chargeable', async () => {
  const store = new Store();
  store.rows = [
    { id: 'queued', state: 'queued' },
    { id: 'remote', state: 'generating', taskId: 'kie-job' },
    { id: 'unknown', state: 'unknown' },
    { id: 'complete', state: 'success' },
  ];
  const queue = new TaskQueue({ store, prepare: async row => row.input, create: async () => ({ taskId: 'provider' }), poll: async () => ({ state: 'waiting' }) });
  queue.schedule = () => {}; queue.schedulePoll = () => {};
  assert.deepEqual(await queue.clear(), { removed: 3, providerMayHaveCharged: true });
  assert.deepEqual((await store.list()).map(row => row.id), ['complete']);
  assert.deepEqual(store.removals, [
    { id: 'queued', settlementState: 'cancelled' },
    { id: 'remote', settlementState: 'success' },
    { id: 'unknown', settlementState: 'success' },
  ]);
  queue.close();
});

test('clear retries a state transition and settles from the locked current state', async () => {
  class RacingStore extends Store {
    async remove(id, settlementState, expectedStates) {
      if (!this.changed) {
        this.changed = true;
        this.rows[0] = { ...this.rows[0], state: 'submitting' };
      }
      return super.remove(id, settlementState, expectedStates);
    }
  }
  const store = new RacingStore(); store.rows = [{ id: 'racing', state: 'preparing' }];
  const queue = new TaskQueue({ store, prepare: async row => row.input, create: async () => ({ taskId: 'provider' }), poll: async () => ({ state: 'waiting' }) });
  queue.schedule = () => {}; queue.schedulePoll = () => {};
  assert.deepEqual(await queue.clear(), { removed: 1, providerMayHaveCharged: true });
  assert.deepEqual(store.removals, [{ id: 'racing', settlementState: 'success' }]);
  queue.close();
});
