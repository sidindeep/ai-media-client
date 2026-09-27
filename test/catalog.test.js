const test = require('node:test');
const assert = require('node:assert/strict');
const { models } = require('../src/catalog');

test('Seedance 2 exposes only server-valid duration choices to clients', () => {
  const model = models.find(item => item.apiModel === 'bytedance/seedance-2');
  const duration = model.fields.find(field => field.key === 'duration');
  assert.deepEqual(duration.options, [-1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  assert.equal(duration.options.includes(17), false);
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
