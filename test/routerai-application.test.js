const test = require('node:test');
const assert = require('node:assert/strict');
const { createRouterAiApplicationProvider } = require('../src/providers/routerai/application');
const { handleGenerationRequest } = require('../src/server/routes/generation');

test('RouterAI facade retains role catalog metadata and distinguishes unknown price and ruble balance', async () => {
  const calls = [];
  const catalog = { models: [{ id: 'model', kind: 'text' }], source: 'fixture' };
  const exact = { amountUnits: 4000, credits: 4, source: 'public' };
  const provider = createRouterAiApplicationProvider({
    catalog: { list: async role => { calls.push(role); return catalog; } },
    client: { credits: async () => 12.5 },
    billing: { quote: async request => request.model === 'model' ? exact : { amountUnits: null },
      submit: async (account, request, role, models) => ({ account, request, role, models }),
      get: async (account, requestId) => ({ account, requestId, state: 'unknown' }) },
  });
  assert.deepEqual(await provider.listModelCatalog('admin'), catalog);
  assert.deepEqual(await provider.listModels('user'), catalog.models);
  assert.deepEqual(calls, ['admin', 'user']);
  assert.deepEqual(await provider.quote({ model: 'model' }), { status: 'exact', credits: 4, nativeQuote: exact });
  assert.deepEqual(await provider.quote({ model: 'unpriced' }), {
    status: 'unavailable', credits: null, nativeQuote: { amountUnits: null } });
  assert.deepEqual(await provider.getStatus(), { configured: true, balance: 12.5, unit: 'rub' });
  assert.deepEqual(await provider.getTask('owner', 'id'), { account: 'owner', requestId: 'id', state: 'unknown' });
  assert.deepEqual(await provider.submit('owner', { requestId: 'id' }, 'user', catalog.models),
    { account: 'owner', request: { requestId: 'id' }, role: 'user', models: catalog.models });
});

test('RouterAI HTTP preserves native quote, account-scoped reads and admin access restrictions', async () => {
  const nativeQuote = { amountUnits: 4000, credits: 4, version: 'test' };
  const id = '11111111-1111-4111-8111-111111111111';
  const calls = [];
  const provider = createRouterAiApplicationProvider({
    catalog: { list: async () => ({ models: [{ id: 'model', kind: 'text' }] }) },
    client: {}, billing: { quote: async () => nativeQuote,
      get: async (account, requestId) => {
        calls.push([account, requestId]);
        return { id: requestId, state: 'unknown', providerCostRub: 5 };
      } },
  });
  const route = (pathname, role = 'user') => handleGenerationRequest({
    req: { method: 'GET', headers: {} }, url: new URL(pathname, 'http://localhost'),
    user: { id: 'owner', role }, accounts: {}, routerAi: provider,
    routerAiAdmin: { listModels: async () => { throw new Error('Must not be called for a user'); } },
    send: (status, body) => ({ status, body }),
  });
  assert.deepEqual(await route('/api/routerai/quote?model=model'), { status: 200, body: { quote: nativeQuote } });
  assert.equal((await route('/api/routerai/quote?model=hidden')).status, 403);
  assert.deepEqual(await route(`/api/routerai/jobs/${id}`), {
    status: 200, body: { id, state: 'unknown' } });
  assert.deepEqual(calls, [['owner', id]]);
  assert.equal((await route(`/api/routerai/jobs/${id}`, 'admin')).body.providerCostRub, 5);
  await assert.rejects(route('/api/routerai/admin/models'), error => error.status === 403);
});
