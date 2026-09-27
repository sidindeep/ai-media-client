const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { testPool } = require('./helpers/pg-pool');
const { openDatabase } = require('../src/database/database');
const { createContentService, parseContentRef, fetchPublicResult } = require('../src/services/content-service');

test('result HTTPS fetch pins the validated address while keeping the original host', async () => {
  let requestedHost, connectedAddress;
  const requestImpl = (url, options, response) => {
    requestedHost = url.hostname;
    const request = new EventEmitter();
    request.end = () => {
      options.lookup(url.hostname, {}, (_error, address) => { connectedAddress = address; });
      const incoming = new PassThrough();
      incoming.statusCode = 200;
      incoming.headers = { 'content-type': 'image/png' };
      response(incoming);
      incoming.end('image');
    };
    return request;
  };
  const lookupImpl = async () => [{ address: '203.0.113.8', family: 4 }];
  const response = await fetchPublicResult('https://provider.example/result', AbortSignal.timeout(1000), lookupImpl, requestImpl);
  assert.equal(await response.text(), 'image');
  assert.equal(requestedHost, 'provider.example');
  assert.equal(connectedAddress, '203.0.113.8');
  await assert.rejects(fetchPublicResult('https://provider.example/result', AbortSignal.timeout(1000),
    async () => [{ address: '127.0.0.1', family: 4 }], () => { throw new Error('Unsafe address was connected'); }), /DNS результата/);
});

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
  const content = await createContentService({ pool, storage, dataDirectory: directory, fetchImpl: options.fetchImpl, interval: 5, concurrency: options.concurrency,
    maxDownloadBytes: options.maxDownloadBytes, maxStagingBytes: options.maxStagingBytes });
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
test('streamed source upload enforces its byte limit and removes an incomplete stage', async t => {
  const { directory, accountId, content } = await setup(t);
  const asset = await content.createFromStream(accountId, { stream: Readable.from([Buffer.alloc(7), Buffer.alloc(7)]),
    name: 'stream.png', type: 'image/png', limit: 14 });
  assert.equal((await content.wait(accountId, asset.id, 5000)).size, 14);
  await assert.rejects(content.createFromStream(accountId, { stream: Readable.from([Buffer.alloc(7), Buffer.alloc(8)]),
    name: 'too-large.png', type: 'image/png', limit: 14 }), /слишком большой/);
  const aborted = Readable.from((async function* () { yield Buffer.alloc(5); throw new Error('client aborted'); })());
  await assert.rejects(content.createFromStream(accountId, { stream: aborted,
    name: 'aborted.png', type: 'image/png', limit: 14 }), /client aborted/);
  assert.deepEqual(await fs.readdir(path.join(directory, 'content-staging')), []);
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

test('remote result stops at its byte limit and removes partial staging', async t => {
  const fetchImpl = async () => new Response(Buffer.alloc(20), { status: 200, headers: { 'Content-Type': 'image/png' } });
  const { directory, pool, accountId, content } = await setup(t, { fetchImpl, maxDownloadBytes: 10 });
  const asset = await content.createFromUrl(accountId, { url: 'https://provider.example/oversized' });
  let rejected = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const job = (await pool.query('SELECT state,last_error FROM content_jobs WHERE asset_id=$1', [asset.id])).rows[0];
    if (job.state === 'retry') { assert.match(job.last_error, /лимит сохранения/); rejected = true; break; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(rejected, true);
  assert.deepEqual(await fs.readdir(path.join(directory, 'content-staging')), []);
});

test('staging quota covers uploads and remote downloads and releases failed partial files', async t => {
  const fetchImpl = async () => new Response(Buffer.alloc(12), { status: 200, headers: { 'Content-Type': 'image/png' } });
  const { directory, pool, accountId, content } = await setup(t, { fetchImpl, maxStagingBytes: 10 });
  await assert.rejects(content.createFromBuffer(accountId, { bytes: Buffer.alloc(11), name: 'large.png', type: 'image/png' }), /квота/);
  await assert.rejects(content.createFromStream(accountId, { stream: Readable.from([Buffer.alloc(6), Buffer.alloc(5)]),
    name: 'stream.png', type: 'image/png', limit: 20 }), /квота/);
  const asset = await content.createFromUrl(accountId, { url: 'https://provider.example/large' });
  for (let attempt = 0; attempt < 100; attempt++) {
    const job = (await pool.query('SELECT state,last_error FROM content_jobs WHERE asset_id=$1', [asset.id])).rows[0];
    if (job.state === 'retry') { assert.match(job.last_error, /квота/); break; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.deepEqual(await fs.readdir(path.join(directory, 'content-staging')), []);
  const small = await content.createFromBuffer(accountId, { bytes: Buffer.alloc(10), name: 'small.png', type: 'image/png' });
  assert.equal((await content.wait(accountId, small.id, 5000)).size, 10);
});

test('remote result rejects local addresses and unsafe redirects', async t => {
  let fetches = 0;
  const fetchImpl = async () => { fetches++; return Response.redirect('https://127.0.0.1/private', 302); };
  const { accountId, content } = await setup(t, { fetchImpl });
  await assert.rejects(content.createFromUrl(accountId, { url: 'https://127.0.0.1/private' }), /Недопустимый адрес/);
  await assert.rejects(content.createFromUrl(accountId, { url: 'http://provider.example/result' }), /Недопустимый адрес/);
  const asset = await content.createFromUrl(accountId, { url: 'https://provider.example/result' });
  const row = await content.file(accountId, asset.id).catch(error => error);
  assert.equal(row.status, 409);
  for (let attempt = 0; attempt < 100; attempt++) {
    const current = await content.file(accountId, asset.id).catch(error => error);
    if (current.message.includes('Недопустимый адрес')) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.match((await content.file(accountId, asset.id).catch(error => error)).message, /Недопустимый адрес/);
  assert.equal(fetches, 1);
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

test('content staged during an S3 outage resumes after worker restart', async t => {
  const storage = memoryStorage();
  const put = storage.put.bind(storage);
  let unavailable = true;
  storage.put = async (...args) => { if (unavailable) throw new Error('S3 unavailable'); return put(...args); };
  const { directory, pool, accountId, content } = await setup(t, { storage });
  const asset = await content.createFromBuffer(accountId, { bytes: Buffer.from('survives-restart'), name: 'retry.png', type: 'image/png' });
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = (await pool.query('SELECT state FROM content_jobs WHERE asset_id=$1', [asset.id])).rows[0]?.state;
    if (state === 'retry') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal((await pool.query('SELECT state FROM content_jobs WHERE asset_id=$1', [asset.id])).rows[0].state, 'retry');
  await content.close();
  unavailable = false;
  const restarted = await createContentService({ pool, storage, dataDirectory: directory, interval: 5 });
  try {
    assert.equal((await restarted.wait(accountId, asset.id, 6000)).status, 'ready');
    assert.equal((await restarted.read(accountId, asset.id)).toString(), 'survives-restart');
    assert.equal((await pool.query('SELECT count(*) AS count FROM content_jobs WHERE asset_id=$1', [asset.id])).rows[0].count, 1);
  } finally { await restarted.close(); }
});

test('a slow content write does not block the next ready asset', async t => {
  const storage = memoryStorage();
  const put = storage.put.bind(storage);
  let releaseSlow, slowStarted;
  const started = new Promise(resolve => { slowStarted = resolve; });
  const gate = new Promise(resolve => { releaseSlow = resolve; });
  let first = true;
  storage.put = async (...args) => {
    if (first) { first = false; slowStarted(); await gate; }
    return put(...args);
  };
  const { accountId, content } = await setup(t, { storage, concurrency: 2 });
  const slow = await content.createFromBuffer(accountId, { bytes: Buffer.from('slow'), name: 'slow.png', type: 'image/png' });
  await started;
  const fast = await content.createFromBuffer(accountId, { bytes: Buffer.from('fast'), name: 'fast.png', type: 'image/png' });
  const ready = await content.wait(accountId, fast.id, 5000);
  assert.equal(ready.status, 'ready');
  assert.equal((await content.file(accountId, slow.id)).path !== undefined, true);
  releaseSlow();
  assert.equal((await content.wait(accountId, slow.id, 5000)).status, 'ready');
});
