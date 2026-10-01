const test = require('node:test');
const assert = require('node:assert/strict');
const { models } = require('../src/catalog');

test('Omnihuman UI policy hides only fast mode while preserving the provider contract', () => {
  const model = models.find(item => item.id === 'kie:omnihuman-1-5');
  assert.deepEqual(model.fields.filter(field => field.uiHidden).map(field => field.key), ['pe_fast_mode']);
  assert.deepEqual(model.fields.filter(field => !field.uiHidden).map(field => field.key),
    ['image_url', 'mask_url', 'audio_url', 'prompt', 'output_resolution', 'seed']);
  const field = model.fields.find(field => field.key === 'pe_fast_mode');
  assert.equal(field.uiHiddenReason, 'absent-from-ui-parameter-table');
  assert.equal(field.default, false);
  assert.equal(model.inputSchema.properties.pe_fast_mode.type, 'boolean');
  assert.equal(model.inputSchema.properties.pe_fast_mode.default, false);
  const Ajv = require('ajv');
  const ajv = new Ajv({ strict: false, validateFormats: false });
  assert.equal(ajv.validate(model.inputSchema, {
    image_url: 'https://example.test/portrait.png', audio_url: 'https://example.test/voice.wav',
    output_resolution: '1080', pe_fast_mode: false, seed: -1,
  }), true);
  assert.equal(model.inputSchema.properties.pe_fast_mode.uiHidden, true);
});

test('Seedance 2 exposes only server-valid duration choices to clients', () => {
  const model = models.find(item => item.apiModel === 'bytedance/seedance-2');
  const duration = model.fields.find(field => field.key === 'duration');
  assert.deepEqual(duration.options, [-1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  assert.equal(duration.options.includes(17), false);
});

test('Kling 3 motion control exposes resolution choices without rewriting the imported catalog', () => {
  const model = models.find(item => item.apiModel === 'kling-3.0/motion-control');
  const mode = model.fields.find(field => field.key === 'mode');
  assert.equal(mode.label, 'Разрешение');
  assert.equal(mode.type, 'select');
  assert.deepEqual(mode.options, ['720p', '1080p']);
  assert.equal(mode.default, '720p');
  assert.deepEqual(model.inputSchema.properties.mode.enum, ['720p', '1080p', 'std', 'pro']);
  assert.equal(model.inputSchema.properties.mode.default, '720p');
  assert.deepEqual(mode.pricingAliases, { std: '720P', pro: '1080P', '720p': '720P', '1080p': '1080P', '4K': '4K' });
  const raw = require('../src/kie-models.json').find(item => item.apiModel === model.apiModel);
  assert.equal(raw.inputSchema.properties.mode.enum, undefined);
  assert.equal(raw.fields.find(field => field.key === 'mode').type, 'text');
});

test('string duration models expose wire-compatible choices and accept saved numeric values', () => {
  const { normalize } = require('../src/duration');
  for (const apiModel of ['grok-imagine/image-to-video', 'kling/v3-turbo-image-to-video', 'kling/v3-turbo-text-to-video']) {
    const model = models.find(item => item.apiModel === apiModel);
    const duration = model.fields.find(field => field.key === 'duration');
    assert.equal(duration.schema.type, 'string');
    assert.ok(duration.options.every(value => typeof value === 'string'));
    const input = { duration: Number(duration.options[0]) };
    assert.equal(normalize(model, input).duration, duration.options[0]);
  }
});

test('corrected media fields retain provider wire keys and upload shapes', () => {
  const find = id => models.find(item => item.apiModel === id);
  const happyHorse = find('happyhorse/image-to-video');
  assert.ok(happyHorse.fields.some(field => field.key === 'image_urls' && field.type === 'files'));
  assert.ok(happyHorse.inputSchema.required.includes('image_urls'));
  assert.equal(happyHorse.inputSchema.properties['image_urls '], undefined);
  assert.equal(find('recraft/crisp-upscale').fields.find(field => field.key === 'image').type, 'files');
  for (const id of ['happyhorse/reference-to-video', 'happyhorse-1-1/reference-to-video']) {
    const field = find(id).fields.find(item => item.key === 'reference_image');
    assert.equal(field.type, 'files');
    assert.equal(field.scalar, false);
  }
  assert.ok(models.every(model => model.fields.every(field => field.key === field.key.trim())));
});

test('union variants accept ordinary input objects after import correction', () => {
  const Ajv = require('ajv');
  const ajv = new Ajv({ strict: false, validateFormats: false });
  const model = models.find(item => item.apiModel === 'kling-3.0-omni/reference-to-video');
  assert.equal(ajv.validate(model.inputSchema, { prompt: 'A scene', image_urls: ['https://example.com/image.png'] }), true);
  assert.equal(ajv.validate(model.inputSchema, { __input: { prompt: 'A scene', image_urls: ['https://example.com/image.png'] } }), false);
});

test('Suno separation accepts either audio source and requires a stem only for advanced splitting', () => {
  const Ajv = require('ajv');
  const model = models.find(item => item.apiModel === 'ai-music-api/separate-vocals');
  const validate = new Ajv({ strict: false, validateFormats: false }).compile(model.inputSchema);
  const existing = { task_id: 'example-task', audio_id: 'example-track' };
  const uploaded = { audio_url: 'https://example.test/audio.mp3' };
  for (const source of [existing, uploaded]) {
    assert.equal(validate(source), true, JSON.stringify(validate.errors));
    for (const type of ['separate_vocal', 'split_stem']) assert.equal(validate({ ...source, type }), true);
    assert.equal(validate({ ...source, type: 'split_stem_advanced' }), false);
    assert.equal(validate({ ...source, type: 'split_stem_advanced', stem_name: 'Lead Vocal' }), true);
    assert.equal(validate({ ...source, type: 'split_stem_advanced', stem_name: '' }), false);
    assert.equal(validate({ ...source, type: 'unknown' }), false);
  }
  for (const input of [{}, { task_id: 'example-task' }, { audio_id: 'example-track' },
    { ...uploaded, audio_id: 'example-track' }, { ...uploaded, task_id: 'example-task' },
    { ...uploaded, ...existing }]) assert.equal(validate(input), false, JSON.stringify(input));
  assert.equal(model.fields.find(field => field.key === 'stem_name').required, false);
  assert.equal(model.fields.find(field => field.key === 'stem_name').uiHidden, undefined);
  assert.equal(model.fields.find(field => field.key === 'type').uiHidden, undefined);
  assert.equal(model.fields.find(field => field.key === 'type').uiVisibleReason, 'required-condition-control');
  assert.equal(model.inputSchema.oneOf[0].properties.audio_id.uiHidden, undefined);
  assert.equal(model.inputSchema.oneOf[1].properties.audio_id, undefined);
  const raw = require('../src/kie-models.json').find(item => item.apiModel === model.apiModel);
  assert.ok(raw.inputSchema.required.includes('stem_name'), 'generated import must remain untouched');
  assert.ok(raw.inputSchema.oneOf[1].required.includes('audio_id'));
  const { buildRequest } = require('../src/adapters');
  assert.deepEqual(buildRequest(model, uploaded), { model: model.apiModel, input: uploaded });
});
