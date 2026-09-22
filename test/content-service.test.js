const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const { randomUUID } = require('node:crypto');
const { testPool } = require('./helpers/pg-pool');
const { openDatabase } = require('../src/database/database');
const { createContentService, parseContentRef } = require('../src/services/content-service');

function memoryStorage() {
  const objects = new Map();
  return {
    objects,
    async put(key, body, type) {
      const chunks = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      objects.set(key, { bytes: Buffer.concat(chunks), type }); return key;
    },
    async head(key) { const item = objects.get(key); if (!item) throw new Error('NotFound'); return { size: item.bytes.length, type: item.type }; },
    async read(key) { const item = objects.get(key); if (!item) throw new Error('NotFound'); return Buffer.from(item.bytes); },
    async stream(key) { const item = objects.get(key); if (!item) throw new Error('NotFound'); return { body: Readable.from(item.bytes), size: item.bytes.length, type: item.type, contentRange: '' }; },
  };
}

async function setup(t, options = {}) {
  const artifacts = path.resolve(__dirname, '../artifacts'); await fs.mkdir(artifacts, { recursive: true });
  const directory = await fs.mkdtemp(path.join(artifacts, 'content-test-'));
  const pool = await openDatabase({}, testPool()), storage = options.storage || memoryStorage();
  const accountId = randomUUID();
  await pool.query("INSERT INTO media_accounts(id,display_name) VALUES($1,'Test')", [accountId]);
  const content = await createContentService({ pool, storage, dataDirectory: directory, fetchImpl: options.fetchImpl, interval: 5 });
  t.after(async () => { await content.close(); await pool.end(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, pool, storage, accountId, content };
}

test('content assets use UUID keys, verify S3 bytes and enforce tenant reads', async t => {
  const { pool, storage, accountId, content } = await setup(t);
  const asset = await content.createFromBuffer(accountId, { bytes: Buffer.from('private-image'), name: '../cat.png', type: 'image/png', origin: { kind: 'source' } });
  assert.equal(parseContentRef(asset.ref), asset.id);
  assert.equal(asset.status, 'saving');
  const ready = await content.wait(accountId, asset.id, 5000);
  assert.equal(ready.status, 'ready'); assert.equal(ready.name, 'cat.png'); assert.equal(ready.size, 13);
  assert.equal(await content.read(accountId, asset.id).then(bytes => bytes.toString()), 'private-image');
  assert.ok(storage.objects.has(`accounts/${accountId}/content/${asset.id}`));
  const finished = (await pool.query('SELECT state,source FROM content_jobs WHERE asset_id=$1', [asset.id])).rows[0];
  assert.equal(finished.state, 'done');
  assert.deepEqual(finished.source, { type: 'stored' });
  const other = randomUUID(); await pool.query("INSERT INTO media_accounts(id,display_name) VALUES($1,'Other')", [other]);
  await assert.rejects(content.file(other, asset.id), error => error.status === 404);
});

test('content URL jobs survive as database work and link ready results to a generation', async t => {
  const fetchImpl = async () => new Response(Buffer.from('generated'), { status: 200, headers: { 'Content-Type': 'image/webp' } });
  const { pool, accountId, content } = await setup(t, { fetchImpl });
  const recordId = randomUUID();
  await pool.query("INSERT INTO media_records(account_id,namespace,id,data) VALUES($1,'history',$2,$3)", [accountId, recordId, JSON.stringify({ id: recordId, state: 'success' })]);
  const asset = await content.createFromUrl(accountId, { url: 'https://provider.example/result', origin: { kind: 'result' } });
  await content.link(accountId, 'history', recordId, asset.id, 'result', 0);
  const ready = await content.wait(accountId, asset.id, 5000);
  assert.equal(ready.type, 'image/webp'); assert.equal(await content.read(accountId, asset.id).then(bytes => bytes.toString()), 'generated');
  const link = (await pool.query('SELECT role,position FROM content_links WHERE asset_id=$1', [asset.id])).rows[0];
  assert.deepEqual({ role: link.role, position: link.position }, { role: 'result', position: 0 });
});

test('a failed content write keeps one asset id and can be retried without regenerating', async t => {
  const storage = memoryStorage(); let failures = 1;
  const put = storage.put.bind(storage);
  storage.put = async (...args) => { if (failures-- > 0) throw new Error('temporary S3 failure'); return put(...args); };
  const { accountId, content } = await setup(t, { storage });
  const asset = await content.createFromBuffer(accountId, { bytes: Buffer.from('retry'), name: 'retry.png', type: 'image/png' });
  const ready = await content.wait(accountId, asset.id, 5000);
  assert.equal(ready.id, asset.id); assert.equal(ready.status, 'ready');
});
