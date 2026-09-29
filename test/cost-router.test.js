const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCostRouter, normalizedRequest } = require('../src/services/cost-router');
const compatibility = require('../config/cost-routing-compatibility.json');
const kieCatalog = require('../src/kie-models.json');

const user = { id: '11111111-1111-4111-8111-111111111111', role: 'admin' };
const requestId = '22222222-2222-4222-8222-222222222222';
const request = { requestId, modelId: 'kie:gpt-image-2-text-to-image',
  input: { prompt: 'A red apple', aspect_ratio: '1:1', resolution: '1K', background: 'opaque' }, projectId: null, chatId: null };

function fixture({ kieUnits = 5000, apimartUsd = 0.03, walletBalance = 100 } = {}) {
  const rows = new Map(), sent = [], balanceAccounts = [];
  const scoped = {
    configured: () => true,
    catalog: () => ({ models: [{ id: 'kie:gpt-image-2-text-to-image' }, { id: 'kie:nano-banana-pro' },
      { id: 'kie:flux-2/pro-text-to-image' }, { id: 'kie:seedance-2.5' }] }),
    providerBalance: async accountId => { balanceAccounts.push(accountId); return 100; },
    providerCostQuote: async () => {
      if (kieUnits === null) throw new Error('Kie tariff unavailable');
      return { amountUnits: kieUnits, productCredits: kieUnits / 1000, version: 'kie-price', source: 'public' };
    },
    dispatch: async (method, args) => { sent.push({ providerId: 'kie', method, args }); return { id: requestId, providerId: 'kie' }; },
  };
  const accounts = { scope: async () => scoped, wallet: { get: async () => ({ balance: walletBalance }) },
    workspaces: { assertBinding: async () => ({}) } };
  const apimart = {
    models: async () => [{ id: 'gpt-image-2' }, { id: 'gemini-3-pro-image-preview' },
      { id: 'flux-2-pro', fields: [{ key: 'size', options: ['1:1'] }, { key: 'resolution', options: ['1K'] }, { key: 'n' }] },
      { id: 'seedance-2.5' }],
    status: async () => ({ balance: { amount: 100 } }),
    quote: async () => apimartUsd === null ? { status: 'unavailable' }
      : { status: 'estimated', amountUsd: apimartUsd, nativeCredits: apimartUsd * 10, credits: apimartUsd * 10 },
    submit: async (_account, args) => { sent.push({ providerId: 'apimart', args }); return { id: requestId, providerId: 'apimart' }; },
  };
  const pool = { query: async (sql, params) => {
    const key = `${params[0]}:${params[1]}`;
    if (sql.startsWith('SELECT')) return { rows: rows.has(key) ? [{ data: rows.get(key) }] : [] };
    if (!rows.has(key)) rows.set(key, JSON.parse(params[2]));
    return { rowCount: 1 };
  } };
  return { router: createCostRouter({ accounts, apimart, pool }), rows, sent, balanceAccounts };
}

test('auto route compares the whole Kie cost with APIMart USD and chooses the cheaper route', async () => {
  const kie = fixture();
  const kieQuote = await kie.router.quote(user, request);
  assert.equal(kieQuote.selected.providerId, 'kie');
  assert.equal(kieQuote.selected.credits, 5);
  assert.equal(kieQuote.selected.providerCredits, 5);
  assert.equal(kieQuote.selected.usdPerProviderCredit, 0.005);
  assert.equal(kieQuote.selected.costUsd, 0.025);
  assert.deepEqual(kie.balanceAccounts, ['primary']);
  await kie.router.submit(user, request);
  assert.equal(kie.sent[0].args[0].kieAccountId, 'primary');
  const apimart = fixture({ apimartUsd: 0.01 });
  const apimartQuote = await apimart.router.quote(user, request);
  assert.equal(apimartQuote.selected.providerId, 'apimart');
  assert.equal(apimartQuote.selected.nativeCredits, 0.1);
  assert.equal(apimartQuote.selected.credits, 0.1);
  assert.equal(apimartQuote.selected.providerCredits, 0.1);
  assert.ok(Math.abs(apimartQuote.selected.usdPerProviderCredit - 0.1) < 1e-12);
  assert.equal(apimartQuote.selected.costUsd, 0.01);
  assert.equal((await apimart.router.submit(user, request)).providerId, 'apimart');
  assert.equal(apimart.sent[0].args.parameters.size, '1:1');
  assert.equal(apimart.sent[0].args.parameters.resolution, '1k');
});

test('unavailable tariffs are excluded and an unknown price is never free', async () => {
  const fallback = fixture({ kieUnits: null });
  assert.equal((await fallback.router.quote(user, request)).selected.providerId, 'apimart');
  const none = fixture({ kieUnits: null, apimartUsd: null });
  await assert.rejects(none.router.quote(user, request), /Нет совместимого провайдера/);
  await assert.rejects(fixture({ walletBalance: 0 }).router.quote(user, request), /Нет совместимого провайдера/);
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

test('incompatible settings keep the other router visible with an explanation', async () => {
  const alternate = { ...request, input: { ...request.input, resolution: '2K' } };
  assert.equal(normalizedRequest(request).model.routes.length, 2);
  assert.equal(normalizedRequest(alternate).model.routes.length, 2);
  const priced = await fixture().router.quote(user, alternate);
  assert.equal(priced.selected.providerId, 'kie');
  assert.match(priced.offers[1].reason, /несовместимы/);
  assert.equal(normalizedRequest({ ...request, sourceFiles: [{ ref: 'content:one' }] }).generic, true);
});

test('Nano Banana Pro compares Kie and APIMart for matching image settings', async () => {
  const nano = { ...request, modelId: 'kie:nano-banana-pro',
    input: { prompt: 'A banana', image_input: [], aspect_ratio: '1:1', resolution: '1K', output_format: 'png' } };
  assert.deepEqual(normalizedRequest(nano).model.routes.map(route => route.providerId), ['kie', 'apimart']);
  const env = fixture({ kieUnits: 18000, apimartUsd: 0.03 });
  const priced = await env.router.quote(user, nano);
  assert.deepEqual(priced.offers.map(offer => offer.providerId), ['kie', 'apimart']);
  assert.equal(priced.selected.providerId, 'apimart');
  await env.router.submit(user, nano);
  assert.equal(env.sent[0].args.model, 'gemini-3-pro-image-preview');
  assert.deepEqual(env.sent[0].args.parameters, { size: '1:1', resolution: '1K', n: 1 });
  assert.ok(normalizedRequest({ ...nano, input: { ...nano.input, output_format: 'jpg' } }).model.routes[1].unavailableReason);
  assert.ok(normalizedRequest({ ...nano, input: { ...nano.input, image_input: ['https://example.com/a.png'] } }).model.routes[1].unavailableReason);
});

test('compatibility table compares a mapped model and explains unmatched models', async () => {
  const mapped = { ...request, modelId: 'kie:flux-2/pro-text-to-image',
    input: { prompt: 'A tree', aspect_ratio: '1:1', resolution: '1K' } };
  const env = fixture({ kieUnits: 18000, apimartUsd: 0.03 });
  const result = await env.router.quote(user, mapped);
  assert.equal(result.selected.providerId, 'apimart');
  assert.deepEqual(result.offers.map(offer => offer.providerId), ['kie', 'apimart']);
  await env.router.submit(user, mapped);
  assert.deepEqual(env.sent[0].args.parameters, { size: '1:1', resolution: '1K', n: 1 });
  const unsupported = await fixture().router.quote(user, { ...request, modelId: 'kie:seedance-2.5', input: { prompt: 'A sea' } });
  assert.equal(unsupported.offers.length, 2);
  assert.match(unsupported.offers[1].reason, /нет модели APIMart/);
});

test('every Kie catalog model has both router rows and compatibility entries refer to known Kie models', () => {
  const ids = new Set(kieCatalog.map(model => model.id));
  assert.equal(new Set(compatibility.pairs.map(pair => pair.kie)).size, compatibility.pairs.length);
  for (const pair of compatibility.pairs) assert.ok(ids.has(pair.kie), pair.kie);
  for (const model of kieCatalog) {
    const routed = normalizedRequest({ modelId: model.id, input: {} });
    assert.deepEqual(routed.model.routes.map(route => route.providerId), ['kie', 'apimart'], model.id);
  }
  assert.deepEqual(normalizedRequest({ modelId: 'apimart:whisper-1', input: {} }).model.routes
    .map(route => route.providerId), ['apimart', 'kie']);
});

test('single-provider catalog entries quote and dispatch through their selected provider', async () => {
  const kieRequest = { ...request, modelId: 'kie:seedance-2.5', input: { prompt: 'A sea' }, sourceFiles: [{ ref: 'content:one' }] };
  const kie = fixture();
  assert.equal((await kie.router.quote(user, kieRequest)).selected.providerId, 'kie');
  await kie.router.submit(user, kieRequest);
  assert.equal(kie.sent[0].args[0].kieAccountId, 'primary');
  assert.deepEqual(kie.sent[0].args[0].sourceFiles, kieRequest.sourceFiles);
  const apimartRequest = { ...request, modelId: 'apimart:seedance-2.5', input: { prompt: 'A sea', duration: 5 } };
  const apimart = fixture();
  assert.equal((await apimart.router.quote(user, apimartRequest)).selected.providerId, 'apimart');
  await apimart.router.submit(user, apimartRequest);
  assert.equal(apimart.sent[0].args.parameters.duration, 5);
  await assert.rejects(kie.router.quote(user, { ...request, modelId: 'kie:unknown' }), /Нет совместимого провайдера/);
});
