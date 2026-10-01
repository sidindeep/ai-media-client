const test = require('node:test');
const assert = require('node:assert/strict');
const { reconcileModelRoutes, publishedKieTariff, createModelRouteSynchronizer } = require('../src/services/model-route-sync');
const { testPool } = require('./helpers/pg-pool');
const { openDatabase } = require('../src/database/database');
const { saveModelConfig, createModelConfigReader, readRouteDocument } = require('../src/services/service-model-configs');
const { models } = require('../src/catalog');
const { modelCandidates } = require('../src/billing/kie-tariff-resolver');
const { quoteKie } = require('../src/billing/kie-pricing');
const { mergeSeedDocument, isNewerManagedVersion } = require('../src/services/model-route-document');
const catalogue = (provider, models, prices) => ({ provider, models, prices: new Map(Object.entries(prices)) });
const model = (id, kind = 'video') => ({ id, apiModel: id.replace(/^kie:/, ''), name: id, kind });
const row = (id, provider, providerId, price) => ({ id, kind: 'video', name: 'User name', action: 'auto',
  providers: { [provider]: providerId }, publishedTariffs: { [provider]: price } });

test('catalogue reconciliation preserves custom data, fills blanks and never pairs providers by name', () => {
  const document = { version: '2026-10-01-unified-2', models: [row('video.keep', 'kie', 'kie:keep', 'owner price'),
    row('video.blank', 'kie', 'kie:blank', '—')] };
  const sources = [catalogue('kie', [model('kie:keep'), model('kie:blank')], { 'kie:keep': 'new price', 'kie:blank': '14' }),
    catalogue('apimart', [model('keep')], { keep: '$1' })];
  const result = reconcileModelRoutes(document, sources);
  assert.equal(result.models[0].name, 'User name');
  assert.equal(result.models[0].publishedTariffs.kie, 'owner price');
  assert.equal(result.models[1].publishedTariffs.kie, '14');
  assert.equal(result.models[2].providers.kie, undefined);
  assert.equal(result.models[2].providers.apimart, 'keep');
  assert.deepEqual(reconcileModelRoutes(result, sources), result);
  assert.equal(document.models[1].publishedTariffs.kie, '—');
});

test('bundled refresh preserves renamed identities, owner prices and unrelated rows', () => {
  const current = { version: '2026-09-30-unified-1', models: [row('owner.id', 'kie', 'kie:keep', 'owner price'),
    row('blank', 'kie', 'kie:blank', '—'), row('user.extra', 'third', 'extra', '1')] };
  const seed = { version: '2026-10-01-unified-2', models: [row('different.id', 'kie', 'kie:keep', '14'),
    row('blank', 'kie', 'kie:blank', '20'), row('new', 'apimart', 'new', '$1')] };
  const result = mergeSeedDocument(current, seed);
  assert.equal(result.models.length, 4);
  assert.equal(result.models[0].id, 'owner.id'); assert.equal(result.models[0].publishedTariffs.kie, 'owner price');
  assert.equal(result.models[1].publishedTariffs.kie, '20');
  assert.equal(result.models[2].providers.third, 'extra');
  assert.equal(result.version, seed.version);
});

test('managed version ordering compares numeric revisions and leaves custom versions alone', () => {
  assert.equal(isNewerManagedVersion('2026-10-01-unified-2', '2026-10-01-unified-10'), false);
  assert.equal(isNewerManagedVersion('2026-10-01-unified-10', '2026-10-01-unified-2'), true);
  assert.equal(isNewerManagedVersion('2026-10-01-unified-2', 'custom'), false);
  assert.equal(isNewerManagedVersion('2026-10-01-unified-2', '2026-10-02-unified-1'), false);
});

test('assembled reader persists new catalogue entries, exposes prices and shares refresh work', async t => {
  const pool = await openDatabase({}, testPool()); t.after(() => pool.end());
  await saveModelConfig(pool, { version: '2026-10-01-unified-2', models: [row('video.kling', 'kie', 'kie:kling-3.0/video', '—')] });
  let calls = 0;
  const refresh = createModelRouteSynchronizer({ pool, loadCatalogues: async () => {
    calls++;
    return [catalogue('kie', [model('kie:kling-3.0/video')], { 'kie:kling-3.0/video': '14 credits / second' }),
      catalogue('apimart', [model('new-video')], { 'new-video': '$1 / second' })];
  } });
  const reader = createModelConfigReader(pool, { refresh });
  const [current, list] = await Promise.all([reader.current(), reader.list()]);
  assert.equal(calls, 1);
  assert.equal(current.models.length, 2);
  assert.equal(list[0].modelCount, 2);
  assert.equal((await readRouteDocument(pool)).models.length, 2);
  await reader.current(); assert.equal(calls, 1);
  const custom = { version: 'custom', models: [row('custom', 'kie', 'kie:chosen', '1')] };
  await saveModelConfig(pool, custom);
  assert.equal((await reader.current()).models.length, 1);
  assert.deepEqual(await readRouteDocument(pool), custom);
  assert.equal(calls, 1);
});

test('shared Kie pages isolate actions, tiers and explicit foreign model IDs', () => {
  const rows = [
    { anchor: 'https://kie.ai/kling-3-0-turbo', modelDescription: 'kling 3.0 turbo, image-to-video, 720P', creditPrice: '18', creditUnit: 'per second' },
    { anchor: 'https://kie.ai/kling-3-0-turbo', modelDescription: 'kling 3.0 turbo, text-to-video, 720P', creditPrice: '18', creditUnit: 'per second' },
    { anchor: 'https://kie.ai/kling-3-0-turbo?model=other', modelDescription: 'kling 3.0 turbo, text-to-video, 720P', creditPrice: '1', creditUnit: 'per second' },
  ];
  const m = models.find(m => m.apiModel === 'kling/v3-turbo-text-to-video');
  assert.deepEqual(modelCandidates(m, rows), [rows[1]]);
  assert.match(publishedKieTariff(m, { rows }), /18/);
  assert.equal(quoteKie(m, { duration: '5', resolution: '720p' }, { rows }).credits, 90);
  const kling = models.find(m => m.apiModel === 'kling-3.0/video');
  const variants = ['720P', '1080P', '4K'].flatMap((resolution, i) => [false, true].map(sound => ({
    anchor: 'https://kie.ai/kling-3-0', modelDescription: `Kling 3.0, video, ${sound ? 'with' : 'without'} audio-${resolution}`,
    creditPrice: String([[14, 20], [18, 27], [67, 67]][i][Number(sound)]), creditUnit: 'per second' })));
  assert.equal(quoteKie(kling, { duration: '5', mode: 'std', sound: false }, { rows: variants }).credits, 70);
  assert.equal(quoteKie(kling, { duration: '5', mode: 'pro', sound: true }, { rows: variants }).credits, 135);
  assert.equal(quoteKie(kling, { duration: '5', mode: '4K', sound: true }, { rows: variants }).credits, 335);
});

test('Qwen2 operations have distinct wire identities and editing requires its documented source', () => {
  const Ajv = require('ajv'); const ajv = new Ajv({ strict: false, validateFormats: false });
  const edit = models.find(m => m.apiModel === 'qwen2/image-edit');
  const text = models.find(m => m.apiModel === 'qwen2/text-to-image');
  assert.ok(text); assert.ok(!text.inputSchema.properties.image_url);
  const validate = ajv.compile(edit.inputSchema);
  assert.equal(validate({ prompt: 'Edit' }), false);
  assert.equal(validate({ prompt: 'Edit', image_url: 'https://example.test/source.png' }), true);
  assert.equal(edit.fields.find(f => f.key === 'image_url').scalar, true);
  for (const action of ['text-to-image', 'image-to-image']) {
    const m = models.find(m => m.apiModel === `qwen2-1/${action}`); assert.ok(m);
    const validate21 = ajv.compile(m.inputSchema);
    assert.equal(validate21({ prompt: 'Example' }), action === 'text-to-image');
    assert.equal(validate21({ prompt: 'Example', image_urls: ['https://example.test/source.png'] }), true);
  }
});

test('shared transform tariffs use the selected tier and trusted referenced media duration', () => {
  const rows = [
    { anchor: 'https://kie.ai/topaz-video-upscaler', modelDescription: 'Topaz Video Upscaler, upscale factor 1x/2x', creditPrice: '8', creditUnit: 'per second' },
    { anchor: 'https://kie.ai/topaz-video-upscaler', modelDescription: 'Topaz Video Upscaler, upscale factor 4x', creditPrice: '14', creditUnit: 'per second' },
    { anchor: 'https://kie.ai/kling-3-motion-control', modelDescription: 'kling 3.0 motion control, video-to-video, 720P', creditPrice: '20', creditUnit: 'per second' },
    { anchor: 'https://kie.ai/kling-3-motion-control', modelDescription: 'kling 3.0 motion control, video-to-video, 1080P', creditPrice: '27', creditUnit: 'per second' },
    { anchor: 'https://kie.ai/infinitalk', modelDescription: 'MeiGen-AI InfiniteTalk, lip sync, up to 15 secondss-480p', creditPrice: '3', creditUnit: 'per second' },
  ];
  const context = { sourceFiles: [
    { ref: 'content:video', type: 'video/mp4', durationSeconds: 6 },
    { ref: 'content:audio', type: 'audio/wav', durationSeconds: 5 },
    { ref: 'content:unused', type: 'video/mp4', durationSeconds: 100 },
  ] };
  const topaz = models.find(m => m.apiModel === 'topaz/video-upscale');
  assert.equal(quoteKie(topaz, { video_url: 'content:video', upscale_factor: '2' }, { rows }, context).credits, 48);
  assert.equal(quoteKie(topaz, { video_url: 'content:video', upscale_factor: '4' }, { rows }, context).credits, 84);
  assert.throws(() => quoteKie(topaz, { video_url: 'content:video', upscale_factor: '4', duration: 1 }, { rows }), /длительность/);
  const motion = models.find(m => m.apiModel === 'kling-3.0/motion-control');
  assert.equal(quoteKie(motion, { video_urls: ['content:video'], mode: 'std' }, { rows }, context).credits, 120);
  assert.equal(quoteKie(motion, { video_urls: ['content:video'], mode: 'pro' }, { rows }, context).credits, 162);
  const talk = models.find(m => m.apiModel === 'infinitalk/from-audio');
  assert.equal(quoteKie(talk, { audio_url: 'content:audio', resolution: '480p' }, { rows }, context).credits, 15);
});
