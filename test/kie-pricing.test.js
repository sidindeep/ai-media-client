const test = require('node:test');
const assert = require('node:assert/strict');
const { quoteKie, modelIdFromAnchor } = require('../src/billing/kie-pricing');

const flux = { id: 'kie:flux-2/pro-image-to-image', apiModel: 'flux-2/pro-image-to-image', providerId: 'kie' };
const rows = [
  { modelDescription: 'Black Forest Labs flux-2 pro, image to image, 1.0s-1K', creditPrice: '5.0', creditUnit: 'per image', anchor: 'https://kie.ai/flux-2?model=flux-2%2Fpro-image-to-image' },
  { modelDescription: 'Black Forest Labs flux-2 pro, image to image, 1.0s-2K', creditPrice: '7.0', creditUnit: 'per image', anchor: 'https://kie.ai/flux-2?model=flux-2%2Fpro-image-to-image' },
];

test('Kie dynamic pricing resolves exact anchor model and selected resolution', () => {
  const tariffData = { fetchedAt: '2026-09-20T00:00:00Z', rows };
  assert.equal(modelIdFromAnchor(rows[0].anchor), 'flux-2/pro-image-to-image');
  assert.deepEqual(quoteKie(flux, { resolution: '1K' }, tariffData), { amountUnits: 5000, credits: 5, scale: 1000, currency: 'credits', version: 'kie-live-2026-09-20' });
  assert.equal(quoteKie(flux, { resolution: '2K' }, tariffData).credits, 7);
});

test('Kie dynamic pricing resolves an exact model id from an anchor path', () => {
  const model = { id: 'kie:nano-banana-2-lite', apiModel: 'nano-banana-2-lite', providerId: 'kie' };
  const row = { modelDescription: 'nano-banana-2-lite, 1k', creditPrice: '4', creditUnit: 'per image', anchor: 'https://kie.ai/nano-banana-2-lite' };
  assert.equal(modelIdFromAnchor(row.anchor), 'nano-banana-2-lite');
  assert.equal(quoteKie(model, { aspect_ratio: 'auto' }, { fetchedAt: '2026-09-20T00:00:00Z', rows: [row] }).credits, 4);
});

test('Kie dynamic pricing treats the published 1/2K tier as both 1K and 2K', () => {
  const model = { id: 'kie:nano-banana-pro', apiModel: 'nano-banana-pro', providerId: 'kie' };
  const tierRows = [
    { modelDescription: 'Google nano banana pro, 1/2K', creditPrice: '18.0', creditUnit: 'per image', anchor: 'https://kie.ai/nano-banana-pro' },
    { modelDescription: 'Google nano banana pro, 4K', creditPrice: '24.0', creditUnit: 'per image', anchor: 'https://kie.ai/nano-banana-pro' },
  ];
  const tariffs = { fetchedAt: '2026-09-20T00:00:00Z', rows: tierRows };
  assert.equal(quoteKie(model, { resolution: '1K' }, tariffs).credits, 18);
  assert.equal(quoteKie(model, { resolution: '2K' }, tariffs).credits, 18);
  assert.equal(quoteKie(model, { resolution: '4K' }, tariffs).credits, 24);
});

test('Kie dynamic pricing multiplies per-second tariffs and rejects ambiguity', () => {
  const model = { id: 'kie:demo/video', apiModel: 'demo/video', providerId: 'kie' };
  const perSecond = { fetchedAt: '2026-09-20T00:00:00Z', rows: [
    { modelDescription: 'Demo video, 1080p, 5s', creditPrice: '1.25', creditUnit: 'per second', anchor: 'https://kie.ai/demo?model=demo%2Fvideo' },
    { modelDescription: 'Demo video, 1080p, 8s', creditPrice: '1.75', creditUnit: 'per second', anchor: 'https://kie.ai/demo?model=demo%2Fvideo' },
  ] };
  assert.equal(quoteKie(model, { resolution: '720p', duration: 8 }, perSecond).credits, 14);
  assert.throws(() => quoteKie(flux, {}, { rows }), /параметров/);
  assert.throws(() => quoteKie(model, { duration: 8 }, { rows: [] }), /недоступна/);
});

test('Tariff cache preserves exact pricing identity fields', async () => {
  const { Tariffs } = require('../src/tariffs');
  let saved;
  const preferences = {
    async list() { return []; },
    async update(id, value) { saved = { id, ...value }; },
  };
  const fetcher = async () => ({
    ok: true,
    async json() {
      return { code: 200, data: { pages: 1, records: [{ ...rows[0], interfaceType: 'image', provider: 'flux', ignored: 'value' }] } };
    },
  });
  const result = await new Tariffs(preferences, fetcher).get(true);
  assert.equal(result.rows[0].anchor, rows[0].anchor);
  assert.equal(result.rows[0].interfaceType, 'image');
  assert.equal(result.rows[0].provider, 'flux');
  assert.equal(result.rows[0].ignored, undefined);
  assert.equal(result.schemaVersion, 2);
  assert.equal(saved.id, 'kie-tariffs');
});

test('Live Kie pricing does not depend on reading or persisting the database cache', async () => {
  const { Tariffs } = require('../src/tariffs');
  let fetches = 0;
  const preferences = {
    async list() { throw new Error('database timeout'); },
    async update() { throw new Error('database timeout'); },
  };
  const fetcher = async () => {
    fetches++;
    return { ok: true, async json() { return { code: 200, data: { pages: 1, records: rows } }; } };
  };
  const tariffs = new Tariffs(preferences, fetcher);
  assert.equal((await tariffs.get()).rows.length, rows.length);
  assert.equal((await tariffs.get()).rows.length, rows.length);
  assert.equal(fetches, 1);
});

test('Kie pricing supports request-like media units and two-image bundles', () => {
  const model = { id: 'kie:demo/image', apiModel: 'demo/image', providerId: 'kie' };
  const tariff = (creditUnit, creditPrice = '4') => ({ fetchedAt: '2026-09-20T00:00:00Z', rows: [{ modelDescription: 'Demo', creditPrice, creditUnit, anchor: 'https://kie.ai/demo?model=demo%2Fimage' }] });
  assert.equal(quoteKie(model, {}, tariff('per generation')).credits, 4);
  assert.equal(quoteKie(model, {}, tariff('per upscale')).credits, 4);
  assert.equal(quoteKie(model, {}, tariff('per vedio')).credits, 4);
  assert.equal(quoteKie(model, { num_images: 3 }, tariff('per 2 images')).credits, 8);
});
