const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createHttpServer } = require('../src/server/http');
const { loadConfig } = require('../src/server/config');
const { createMediaService } = require('../src/services/media-service');
const { History } = require('../src/history');

test('web replica does not scan or save completed media on startup', async t => {
  const root = path.resolve(__dirname, '../artifacts');
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'replica-web-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const history = new History(path.join(directory, 'history.json'));
  let scanned = 0;
  history.listNeedingSave = async () => { scanned++; return []; };
  const service = await createMediaService({ directory, provider: { id: 'kie', isConfigured: () => true },
    stores: { history }, content: {}, accountId: randomUUID(), background: false });
  t.after(() => service.close());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scanned, 0);
});

test('web replica streams writes to its executor and rejects foreign origins', async t => {
  const received = [];
  let firstUploadChunk;
  const uploadStarted = new Promise(resolve => { firstUploadChunk = resolve; });
  const executor = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) { chunks.push(chunk); if (req.url === '/api/source/upload' && chunks.length === 1) firstUploadChunk(); }
    received.push({ method: req.method, url: req.url, host: req.headers.host,
      origin: req.headers.origin, body: req.url === '/api/source/upload' ? null : Buffer.concat(chunks).toString(),
      bytes: chunks.reduce((total, chunk) => total + chunk.length, 0) });
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ accepted: true }));
  });
  await new Promise(resolve => executor.listen(0, '127.0.0.1', resolve));
  const executorOrigin = `http://127.0.0.1:${executor.address().port}`;
  const config = loadConfig({ MEDIA_PORT: '0', MEDIA_AUTH_ENABLED: 'false', MEDIA_REPLICA_ROLE: 'web',
    MEDIA_EXECUTOR_URL: executorOrigin, MEDIA_EXECUTOR_PUBLIC_ORIGIN: executorOrigin });
  const web = createHttpServer({ config, service: { configured: () => false } });
  await new Promise(resolve => web.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    web.closeIdleConnections(); executor.closeIdleConnections();
    await Promise.all([new Promise(resolve => web.close(resolve)), new Promise(resolve => executor.close(resolve))]);
  });
  const webOrigin = `http://127.0.0.1:${web.address().port}`;
  const response = await fetch(webOrigin + '/api/rpc/createTask', { method: 'POST',
    headers: { Origin: webOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'test' }) });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { accepted: true });
  assert.deepEqual(received, [{ method: 'POST', url: '/api/rpc/createTask', host: new URL(executorOrigin).host,
    origin: executorOrigin, body: '{"prompt":"test"}', bytes: 17 }]);
  const upload = http.request(webOrigin + '/api/source/upload', { method: 'POST',
    headers: { Origin: webOrigin, 'Content-Type': 'application/octet-stream' } });
  const uploaded = new Promise((resolve, reject) => {
    upload.once('response', response => { response.resume(); response.once('end', () => resolve(response.statusCode)); });
    upload.once('error', reject);
  });
  upload.write(Buffer.alloc(64 * 1024, 1));
  let timeout;
  try { await Promise.race([uploadStarted, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Upload was buffered before forwarding')), 3000); })]); }
  finally { clearTimeout(timeout); }
  upload.end(Buffer.alloc(64 * 1024, 2));
  assert.equal(await uploaded, 202);
  assert.equal(received[1].bytes, 128 * 1024);
  const forbidden = await fetch(webOrigin + '/api/rpc/createTask', { method: 'POST',
    headers: { Origin: 'https://foreign.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(forbidden.status, 403);
  assert.equal(received.length, 2);
  for (const unsafePath of ['//127.0.0.1:1/api/rpc/createTask', '/%2f127.0.0.1:1/api/rpc/createTask', '/api\\rpc\\createTask']) {
    const response = await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: web.address().port, path: unsafePath, method: 'POST' }, reply => {
        reply.resume(); reply.once('end', () => resolve(reply));
      });
      request.once('error', reject); request.end();
    });
    assert.equal(response.statusCode, 400, unsafePath);
  }
  assert.equal(received.length, 2);
});
