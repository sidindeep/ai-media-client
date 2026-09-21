const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { History } = require('../src/history');

test('history persists concurrent tasks and merges status after reopening', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-history-test-'));
  const file = path.join(dir, 'history.json');
  try {
    const store = new History(file);
    assert.deepEqual(await store.list(), []);
    const writes = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => store.update(String(i), { input: { prompt: `Scene ${i}` }, state: 'waiting' })));
    for (const write of writes) if (write.status === 'rejected') throw write.reason;
    const reopened = new History(file);
    await reopened.update('3', { state: 'success', creditsConsumed: 0, resultJson: '{"resultUrls":[]}' });
    const records = await reopened.list();
    assert.equal(records.length, 20);
    assert.equal(records.find(r => r.id === '3').input.prompt, 'Scene 3');
    assert.equal(records.find(r => r.id === '3').creditsConsumed, 0);
    assert.equal(records.find(r => r.id === '3').state, 'success');
  } finally {
    await fs.unlink(file).catch(() => {});
    await fs.rmdir(dir);
  }
});

test('corrupt history is reported and never silently overwritten', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-history-test-'));
  const file = path.join(dir, 'history.json');
  try {
    await fs.writeFile(file, 'broken');
    const store = new History(file);
    await assert.rejects(store.update('new', { state: 'waiting' }));
    assert.equal(await fs.readFile(file, 'utf8'), 'broken');
  } finally { await fs.unlink(file); await fs.rmdir(dir); }
});

test('remove deletes a record from persistent history', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-history-remove-test-'));
  const file = path.join(dir, 'history.json');
  try {
    const store = new History(file);
    await store.update('one', { state: 'queued' });
    await store.update('two', { state: 'success' });
    assert.equal((await store.remove('one')).id, 'one');
    assert.deepEqual((await new History(file).list()).map(record => record.id), ['two']);
    assert.equal(await store.remove('missing'), null);
  } finally { await fs.unlink(file); await fs.rmdir(dir); }
});
