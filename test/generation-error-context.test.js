const test = require('node:test');
const assert = require('node:assert/strict');
const { generationContext } = require('../src/ai-logger/generation-context.mjs');
const { createForwarder } = require('../src/ai-logger');
const { sanitizer } = require('../src/ai-logger/diagnostics');

const assetId = '01234567-1234-4567-89ab-0123456789ab';
const origin = 'https://media.example.test';

test('generation errors deliver the prompt and stable sources through the complete HTTP boundary', async t => {
  const logger = require('../src/ai-logger');
  const { appendGenerationEvent } = require('../src/services/generation-journal');
  const saved = [], businessRows = [];
  const forwarder = createForwarder({ env: { AI_LOGGER_SERVER_URL: 'https://logger.example/ingest' },
    fetchImpl: async (_, options) => { saved.push(JSON.parse(options.body)); return { ok: true }; } });
  const original = logger.reportSystemError, previousOrigin = process.env.MEDIA_PUBLIC_ORIGIN;
  logger.reportSystemError = row => forwarder.systemError(row);
  process.env.MEDIA_PUBLIC_ORIGIN = origin;
  t.after(async () => {
    logger.reportSystemError = original;
    if (previousOrigin === undefined) delete process.env.MEDIA_PUBLIC_ORIGIN;
    else process.env.MEDIA_PUBLIC_ORIGIN = previousOrigin;
    await forwarder.close();
  });
  sanitizer.secret('generation-registered-secret');
  const prompt = 'Нарисуй кота\n' + 'промпт '.repeat(60) + 'prompt="red cat"; token="private-token"; generation-registered-secret';
  for (const provider of ['kie', 'codex', 'routerai', 'apimart']) {
    const record = { id: 'job-' + provider, requestId: 'request-' + provider, model: 'image-model', state: 'fail',
      ...(provider === 'kie' ? { input: { prompt, image_input: ['content:' + assetId] } } : { prompt }),
      sourceFiles: provider === 'codex' ? ['content:' + assetId] : [{ ref: 'content:' + assetId, type: 'image/png' }],
      parameters: { image_urls: ['content:' + assetId, 'https://user:pass@images.example.test/photo.jpg?token=signed-secret'] },
      errorInfo: { providerCode: '1501', providerMessage: 'Content review failed' },
      resultUrls: ['https://results.example.test/not-a-source.png'], apiKey: 'private-account-key' };
    await appendGenerationEvent({ async query(_, args) { businessRows.push(args[3]); } }, 'account-private', provider, record, 'fail');
  }
  await forwarder.flush();
  assert.equal(saved.length, 4);
  for (const row of saved) {
    assert.equal(row.level, 'ERROR');
    assert.match(row.context.prompt, /^Нарисуй кота\n/);
    assert.ok(row.context.prompt.length > 200);
    assert.match(row.context.prompt, /prompt="red cat"/);
    assert.deepEqual(row.context.source_urls, [origin + '/api/content/' + assetId, 'https://images.example.test/photo.jpg']);
    assert.equal(row.context.model, 'image-model');
    assert.match(row.context.description, /Content review failed/);
    assert.equal(row.context.error_code, '1501');
    for (const forbidden of ['private-token', 'generation-registered-secret', 'signed-secret', 'user:pass',
      'account-private', 'private-account-key', 'not-a-source']) assert.ok(!JSON.stringify(row).includes(forbidden), forbidden);
  }
  assert.ok(businessRows.every(row => !row.includes('Нарисуй кота') && !row.includes(assetId)));
});

test('prompt-shaped JSON is preserved only in explicit error context; other levels and arbitrary details exclude it', async () => {
  const saved = [];
  const forwarder = createForwarder({ env: { AI_LOGGER_SERVER_URL: 'https://logger.example/ingest' },
    fetchImpl: async (_, options) => { saved.push(JSON.parse(options.body)); return { ok: true }; } });
  const prompt = '{"prompt":"Кот", "token":"json-private-token"}';
  forwarder.systemError({ source: 'generation', event: 'kie.fail', generation: { prompt, source_urls: [] } });
  forwarder.systemError({ source: 'server', event: 'other.error', diagnostic: { prompt }, details: { prompt } });
  forwarder.generation('generation.completed', 'kie', { state: 'success', prompt });
  await forwarder.flush(); await forwarder.close();
  assert.match(saved[0].context.prompt, /"prompt":"Кот"/);
  assert.ok(!JSON.stringify(saved).includes('json-private-token'));
  assert.deepEqual(saved[0].context.source_urls, []);
  assert.equal(saved[1].context.prompt, undefined);
  assert.equal(saved[2].context.prompt, undefined);
  assert.equal(saved[2].context.source_urls, undefined);
});

test('Kie pipeline errors carry the original prompt and do not contaminate the next request', async t => {
  const trace = require('../src/generation-log');
  const logger = require('../src/ai-logger');
  const saved = [], original = logger.reportSystemError;
  const forwarder = createForwarder({ env: { AI_LOGGER_SERVER_URL: 'https://logger.example/ingest' },
    fetchImpl: async (_, options) => { saved.push(JSON.parse(options.body)); return { ok: true }; } });
  logger.reportSystemError = row => forwarder.systemError(row);
  t.after(async () => { logger.reportSystemError = original; await forwarder.close(); });
  const error = Object.assign(new Error('Invalid parameters'), { providerCode: 422, providerMessage: 'resolution is not supported' });
  await trace.run({ id: 'job-a', modelId: 'kie-image', input: { prompt: 'Первый промпт', image_input: ['content:' + assetId] } },
    () => assert.rejects(trace.step('task.create', {}, async () => { throw error; }), error));
  await forwarder.flush();
  trace.write('http.error', { error: new Error('Unrelated network failure') });
  await forwarder.flush();
  assert.equal(saved[0].context.prompt, 'Первый промпт');
  assert.ok(saved[0].context.source_urls[0].endsWith('/api/content/' + assetId));
  assert.equal(saved[0].context.description, 'resolution is not supported');
  assert.equal(saved[0].context.error_code, '422');
  assert.match(saved[0].exception.stack_trace, /generation-error-context.test.js/);
  assert.equal(saved[1].context.prompt, undefined);
});

test('source collection covers legacy and nested references and never embeds file bytes', () => {
  const hash = 'a'.repeat(64);
  const context = generationContext({ prompt: 'Draw a cat', sourceFiles: ['https://local-assets.invalid/' + hash],
    parameters: { subjects: [{ image: 'content:' + assetId }], image_url: 'data:image/png;base64,PRIVATEBYTES' } }, 'apimart', origin);
  assert.deepEqual(context.source_urls, [origin + '/api/sources/' + hash, origin + '/api/content/' + assetId]);
  assert.equal(generationContext({ input: { prompt: 'Text only' } }, 'kie', '').source_urls.length, 0);
  const { sanitizeGenerationContext } = require('../src/ai-logger/generation-context.mjs');
  assert.equal(sanitizeGenerationContext({ prompt: 'a'.repeat(40000), source_urls: Array(120).fill(origin + '/photo') }, sanitizer).prompt.length, 32768);
  assert.deepEqual(sanitizeGenerationContext(generationContext({ sourceFiles: ['content:' + assetId] }, 'codex', ''), sanitizer).source_urls,
    ['/api/content/' + assetId]);
});
