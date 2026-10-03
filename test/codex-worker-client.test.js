const test = require('node:test');
const assert = require('node:assert/strict');
const { createCodexWorkerClient } = require('../src/providers/codex/worker-client');

test('Codex worker client preserves account scope, catalog metadata and auth actions', async () => {
  const calls = [];
  const catalog = { source: 'app-server', checkedAt: '2026-10-01', models: [] };
  const client = createCodexWorkerClient({ url: 'http://worker/', fetchImpl: async (url, options) => {
    calls.push({ url, ...options });
    return { ok: true, text: async () => JSON.stringify(url.endsWith('/models') ? catalog : { state: 'running' }) };
  } });
  assert.deepEqual(await client.listModels(), catalog);
  await client.submit('account-a', { requestId: 'request-a' });
  await client.getTask('account-a', 'request-a');
  await client.auth('account-a', 'start');
  assert.deepEqual(calls.map(call => [call.url, call.method, call.headers['X-Account-Id']]), [
    ['http://worker/models', 'GET', 'local'], ['http://worker/jobs', 'POST', 'account-a'],
    ['http://worker/jobs/request-a', 'GET', 'account-a'], ['http://worker/auth/start', 'POST', 'account-a'],
  ]);
  assert.equal(calls[1].body, JSON.stringify({ requestId: 'request-a' }));
  assert.throws(() => client.auth('account-a', '../jobs'), /Invalid/);
});

test('Codex worker client keeps confirmed rejection evidence and sanitizes errors', async () => {
  const client = createCodexWorkerClient({ url: 'http://worker', fetchImpl: async () => ({ ok: false, status: 429,
    headers: { get: () => '2' }, text: async () => JSON.stringify({ accepted: false,
      error: { code: 'overloaded', message: 'Busy; Bearer private-token' }, prompt: 'PRIVATE' }) }) });
  await assert.rejects(client.submit('account-a', {}), error => {
    assert.equal(error.remoteStatus, 429); assert.equal(error.confirmedRejected, true);
    assert.equal(error.retryAfterMs, 2000); assert.match(error.message, /overloaded/);
    assert.doesNotMatch(error.message, /private-token|PRIVATE/); return true;
  });
  const broken = createCodexWorkerClient({ url: 'http://worker', fetchImpl: async () => ({ ok: false, status: 502,
    text: async () => '<html>bad gateway</html>' }) });
  await assert.rejects(broken.getTask('account-a', 'request-a'), error => {
    assert.equal(error.remoteStatus, 502); assert.notEqual(error.confirmedRejected, true);
    assert.match(error.message, /некорректный ответ/); return true;
  });
});

test('worker identity is taken only from a valid private response header, including missing-job errors', async () => {
  let instanceId = require('node:crypto').randomUUID();
  const client = createCodexWorkerClient({ url: 'http://worker', fetchImpl: async url => ({
    ok: url.endsWith('/health'), status: url.endsWith('/health') ? 200 : 404,
    headers: { get: () => instanceId }, json: async () => ({ error: 'Запрос не найден' }),
  }) });
  assert.equal(await client.getIdentity(), instanceId);
  await assert.rejects(client.getTask('account-a', 'request-a'), error => error.workerInstanceId === instanceId);
  instanceId = 'DO_NOT_STORE_PAYLOAD';
  assert.equal(await client.getIdentity(), null);
  await assert.rejects(client.getTask('account-a', 'request-a'), error => error.workerInstanceId === null);
});
