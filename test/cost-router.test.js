const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCostRouter, normalizedRequest } = require('../src/services/cost-router');

const user = { id: '11111111-1111-4111-8111-111111111111', role: 'admin' };
const requestId = '22222222-2222-4222-8222-222222222222';
const request = { requestId, modelId: 'kie:gpt-image-2-text-to-image',
  input: { prompt: 'A red apple', aspect_ratio: '1:1', resolution: '1K', background: 'opaque' }, projectId: null, chatId: null };

function fixture({ kieUnits = 5000, apimartUsd = 0.03 } = {}) {
  const rows = new Map(), sent = [];
  const scoped = {
    configured: () => true,
    providerBalance: async () => 100,
    providerCostQuote: async () => {
      if (kieUnits === null) throw new Error('Kie tariff unavailable');
      return { amountUnits: kieUnits, version: 'kie-price', source: 'public' };
    },
    dispatch: async (method, args) => { sent.push({ providerId: 'kie', method, args }); return { id: requestId, providerId: 'kie' }; },
  };
  const accounts = { scope: async () => scoped, workspaces: { assertBinding: async () => ({}) } };
  const apimart = {
    status: async () => ({ balance: { amount: 100 } }),
    quote: async () => apimartUsd === null ? { status: 'unavailable' }
      : { status: 'estimated', amountUsd: apimartUsd },
    submit: async (_account, args) => { sent.push({ providerId: 'apimart', args }); return { id: requestId, providerId: 'apimart' }; },
  };
  const pool = { query: async (sql, params) => {
    const key = `${params[0]}:${params[1]}`;
    if (sql.startsWith('SELECT')) return { rows: rows.has(key) ? [{ data: rows.get(key) }] : [] };
    if (!rows.has(key)) rows.set(key, JSON.parse(params[2]));
    return { rowCount: 1 };
  } };
  return { router: createCostRouter({ accounts, apimart, pool }), rows, sent };
}

test('auto route compares the whole Kie cost with APIMart USD and chooses the cheaper route', async () => {
  const kie = fixture();
  assert.equal((await kie.router.quote(user, request)).selected.providerId, 'kie');
  const apimart = fixture({ apimartUsd: 0.01 });
  assert.equal((await apimart.router.quote(user, request)).selected.providerId, 'apimart');
  assert.equal((await apimart.router.submit(user, request)).providerId, 'apimart');
  assert.equal(apimart.sent[0].args.parameters.size, '1:1');
  assert.equal(apimart.sent[0].args.parameters.resolution, '1k');
});

test('unavailable tariffs are excluded and an unknown price is never free', async () => {
  const fallback = fixture({ kieUnits: null });
  assert.equal((await fallback.router.quote(user, request)).selected.providerId, 'apimart');
  const none = fixture({ kieUnits: null, apimartUsd: null });
  await assert.rejects(none.router.quote(user, request), /Нет совместимого провайдера/);
});

test('one request ID keeps its chosen provider across price changes and rejects changed parameters', async () => {
  const env = fixture({ apimartUsd: 0.01 });
  await env.router.submit(user, request);
  await env.router.submit(user, request);
  assert.equal(env.rows.size, 1);
  assert.deepEqual(env.sent.map(item => item.providerId), ['apimart', 'apimart']);
  await assert.rejects(env.router.submit(user, { ...request, input: { ...request.input, prompt: 'Other' } }),
    /уже имеет другие параметры/);
});

test('pilot excludes unsupported options and source images', () => {
  assert.throws(() => normalizedRequest({ ...request, input: { ...request.input, aspect_ratio: '1:8' } }), /не поддерживают/);
  assert.throws(() => normalizedRequest({ ...request, input: { ...request.input, background: 'transparent' } }), /не поддерживают/);
  assert.throws(() => normalizedRequest({ ...request, input: { ...request.input, resolution: '2K' } }), /не поддерживают/);
  assert.throws(() => normalizedRequest({ ...request, sourceFiles: [{ ref: 'content:one' }] }), /не поддерживают/);
  assert.throws(() => normalizedRequest({ ...request, input: { ...request.input, input_urls: ['https://example.com/a.png'] } }), /не поддерживают/);
});
