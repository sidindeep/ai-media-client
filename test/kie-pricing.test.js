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

test('Kie dynamic pricing resolves provider-prefixed models from a short official anchor', () => {
  const model = { id: 'kie:bytedance/seedance-2-5', apiModel: 'bytedance/seedance-2-5', providerId: 'kie' };
  const seedanceRows = [
    { modelDescription: 'bytedance/seedance-2-5, 720p with video', creditPrice: '38', creditUnit: 'per second', anchor: 'https://kie.ai/seedance-2-5' },
    { modelDescription: 'bytedance/seedance-2-5, 720p no video', creditPrice: '63', creditUnit: 'per second', anchor: 'https://kie.ai/seedance-2-5' },
  ];
  const tariffData = { fetchedAt: '2026-09-21T00:00:00Z', rows: seedanceRows };
  const input = { resolution: '720p', duration: 10, reference_video_urls: ['https://example.test/reference.mp4'] };
  const context = { sourceFiles: [{ ref: input.reference_video_urls[0], type: 'video/mp4', durationSeconds: 18.143125 }] };
  assert.equal(quoteKie(model, input, tariffData, context).credits, 1069.439);
  assert.throws(() => quoteKie(model, input, tariffData), /длительность исходного видео/);
});

test('Kie dynamic pricing matches dotted model versions to hyphenated official paths', () => {
  const model = { id: 'kie:bytedance/seedance-1.5-pro', apiModel: 'bytedance/seedance-1.5-pro', providerId: 'kie' };
  const tariffData = { fetchedAt: '2026-09-22T00:00:00Z', rows: [
    { modelDescription: 'bytedance/seedance-1.5-pro, without audio-720p', creditPrice: '3.5', creditUnit: 'per second', anchor: 'https://kie.ai/seedance-1-5-pro' },
    { modelDescription: 'bytedance/seedance-1.5-pro, with audio-720p', creditPrice: '7', creditUnit: 'per second', anchor: 'https://kie.ai/seedance-1-5-pro' },
  ] };

  assert.equal(quoteKie(model, { resolution: '720p', duration: 4, generate_audio: false }, tariffData).credits, 14);
  assert.equal(quoteKie(model, { resolution: '720p', duration: 4, generate_audio: true }, tariffData).credits, 28);
});

test('Kie pricing uses exact versioned fallbacks for ByteDance V1 models missing from the live catalog', () => {
  const quote = (apiModel, resolution, duration) => quoteKie(
    { id: `kie:${apiModel}`, apiModel, providerId: 'kie' },
    { resolution, duration },
    { fetchedAt: '2026-09-22T00:00:00Z', rows: [] },
  );
  assert.deepEqual(quote('bytedance/v1-lite-text-to-video', '720p', 5), {
    amountUnits: 22500,
    credits: 22.5,
    scale: 1000,
    currency: 'credits',
    version: 'kie-page-2026-09-22-seedance-v1',
  });
  assert.equal(quote('bytedance/v1-lite-image-to-video', '1080p', '10').credits, 100);
  assert.equal(quote('bytedance/v1-pro-text-to-video', '480p', 5).credits, 14);
  assert.equal(quote('bytedance/v1-pro-image-to-video', '720P', 10).credits, 60);
  assert.equal(quote('bytedance/v1-pro-fast-image-to-video', '720p', 5).credits, 16);
  assert.equal(quote('bytedance/v1-pro-fast-image-to-video', '1080p', 10).credits, 72);
});

test('Kie ByteDance V1 fallback covers every configured catalog variant exactly', () => {
  const config = require('../config/kie-price-fallbacks.json');
  const catalogModels = require('../src/kie-models.json')
    .filter(model => model.apiModel.startsWith('bytedance/v1-'))
    .map(model => model.apiModel)
    .sort();
  assert.deepEqual(Object.keys(config.models).sort(), catalogModels);
  let checked = 0;
  for (const [apiModel, variants] of Object.entries(config.models)) {
    for (const variant of variants) {
      const quote = quoteKie(
        { id: `kie:${apiModel}`, apiModel, providerId: 'kie' },
        { resolution: variant.resolution, duration: variant.duration },
        { rows: [] },
      );
      assert.equal(quote.amountUnits, variant.amountUnits, `${apiModel} ${variant.resolution} ${variant.duration}s`);
      checked++;
    }
  }
  assert.equal(checked, 28);
});

test('Kie ByteDance V1 fallback rejects unpublished combinations and incomplete input', () => {
  const model = { id: 'kie:bytedance/v1-pro-fast-image-to-video', apiModel: 'bytedance/v1-pro-fast-image-to-video', providerId: 'kie' };
  assert.throws(() => quoteKie(model, { resolution: '480p', duration: 5 }, { rows: [] }), /параметров/);
  assert.throws(() => quoteKie(model, { resolution: '720p' }, { rows: [] }), /разрешение и длительность/);
});

test('Kie live tariff remains authoritative when a ByteDance V1 fallback exists', () => {
  const model = { id: 'kie:bytedance/v1-lite-text-to-video', apiModel: 'bytedance/v1-lite-text-to-video', providerId: 'kie' };
  const live = {
    fetchedAt: '2026-09-23T00:00:00Z',
    rows: [{
      modelDescription: 'bytedance/v1-lite-text-to-video, 720p',
      creditPrice: '9',
      creditUnit: 'per second',
      anchor: 'https://kie.ai/bytedance-v1?model=bytedance%2Fv1-lite-text-to-video',
    }],
  };
  const quote = quoteKie(model, { resolution: '720p', duration: 5 }, live);
  assert.equal(quote.credits, 45);
  assert.equal(quote.version, 'kie-live-2026-09-23');
});

test('Kie explicit anchor model id wins over a matching short path suffix', () => {
  const model = { id: 'kie:vendor/demo', apiModel: 'vendor/demo', providerId: 'kie' };
  const tariffData = { rows: [
    { modelDescription: 'Other demo', creditPrice: '1', creditUnit: 'per request', anchor: 'https://kie.ai/demo?model=other%2Fdemo' },
  ] };
  assert.throws(() => quoteKie(model, {}, tariffData), /не опубликована/);
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

test('Kie pricing supports audio tariffs per thousand characters', () => {
  const model = { id: 'kie:elevenlabs/text-to-speech-turbo-2-5', apiModel: 'elevenlabs/text-to-speech-turbo-2-5', providerId: 'kie' };
  const tariff = { fetchedAt: '2026-09-21T00:00:00Z', rows: [{ modelDescription: 'Elevenlabs Text to Speech, turbo 2.5', creditPrice: '6', creditUnit: 'per 1000 characters', anchor: 'https://kie.ai/elevenlabs-tts?model=elevenlabs%2Ftext-to-speech-turbo-2-5' }] };
  assert.equal(quoteKie(model, { text: 'Озвучь этот текст' }, tariff).credits, 6);
  assert.equal(quoteKie(model, { text: 'a'.repeat(1001) }, tariff).credits, 12);
  assert.throws(() => quoteKie(model, { text: '' }, tariff), /нужен текст/);
});
