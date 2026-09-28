const test = require('node:test');
const assert = require('node:assert/strict');
const { createApimartClient } = require('../src/providers/apimart/client');
const { createApimartJobs } = require('../src/services/apimart-jobs');

test('APIMart selects chat models and never sends the same accepted request twice', async () => {
  const account = '11111111-1111-4111-8111-111111111111';
  const requestId = '22222222-2222-4222-8222-222222222222';
  const jobs = new Map();
  const requests = [];
  let finished;
  const completed = new Promise(resolve => { finished = resolve; });
  const query = async (sql, params = []) => {
    if (sql.startsWith('SELECT data FROM media_records')) return { rows: jobs.has(params[1]) ? [{ data: jobs.get(params[1]) }] : [] };
    if (sql.startsWith('INSERT INTO media_records') && sql.includes("'apimart'")) jobs.set(params[1], JSON.parse(params[2]));
    if (sql.startsWith('UPDATE media_records')) { jobs.set(params[1], JSON.parse(params[2])); finished(); }
    return { rows: [] };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  const fetchImpl = async (url, init) => {
    requests.push({ url, body: init?.body });
    return { ok: true, json: async () => url.includes('/models?') ? { data: [
      { id: 'gpt-4o', category: 'chat' }, { id: 'gpt-image-2', category: 'image' },
    ] } : { choices: [{ message: { content: 'Готово' } }], usage: { total_tokens: 9 } } };
  };
  const jobsService = createApimartJobs({ pool, apiKey: 'private-test-key', fetchImpl });
  assert.deepEqual(await jobsService.models(), [{ id: 'gpt-4o', name: 'gpt-4o', kind: 'text' }]);
  const input = { requestId, model: 'gpt-4o', prompt: 'Привет' };
  const initial = await jobsService.submit(account, input);
  assert.equal(initial.state, 'running');
  await completed;
  assert.equal((await jobsService.get(account, requestId)).output, 'Готово');
  assert.equal((await jobsService.submit(account, input)).state, 'success');
  assert.equal(requests.filter(item => item.url.endsWith('/chat/completions')).length, 1);
  assert.equal(JSON.stringify([...jobs.values()]).includes('private-test-key'), false);
  await assert.rejects(() => jobsService.submit(account, { ...input, model: 'other-model' }), { status: 409 });
});

test('APIMart catalogue rejects insufficient balance without sending a generation', async () => {
  const requests = [];
  const client = createApimartClient({ apiKey: 'private-test-key', fetchImpl: async url => {
    requests.push(url);
    return { ok: false, status: 402, json: async () => ({ error: { message: 'insufficient balance' } }) };
  } });
  await assert.rejects(() => client.models(), { status: 402 });
  assert.equal(requests.length, 1);
  assert.match(requests[0], /\/models\?expand=category$/);
});
