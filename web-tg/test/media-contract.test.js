const test = require('node:test');
const assert = require('node:assert/strict');
const modules = Promise.all([import('../src/media/index.mjs'), import('../src/media/kie-adapter.mjs')]);
const profile = { id: 'video', providerModel: 'native/video', protocol: 'market', kind: 'video', promptRequired: true,
  assets: [{ kind: 'image', role: 'reference', field: 'image_urls', multiple: true, maxItems: 2 }], parameters: { aspectRatio: 'aspect_ratio' } };
const ref = { provider: 'kie', modelId: 'video', id: 'job' };
const fakeClient = overrides => ({ createTask: async () => ({ taskId: 'job' }), getTask: async () => ({ taskId: 'job', state: 'waiting' }), uploadFile: async () => ({ downloadUrl: 'https://example.test/file' }), ...overrides });

test('application service accepts different providers without changing common data', async () => {
  const [{ createMediaService }, { createKieMediaAdapter }] = await modules;
  const kie = createKieMediaAdapter({ client: fakeClient(), models: [profile] });
  const other = { id: 'other', listModels: () => [], uploadAsset: async x => x, submit: async () => ({ provider: 'other', id: 'o' }), getTask: async t => ({ ...t, state: 'succeeded' }) };
  const service = createMediaService([kie, other]);
  assert.deepEqual(service.listProviders(), ['kie', 'other']);
  assert.equal((await service.getTask(await service.submit('other', {}))).state, 'succeeded');
  assert.throws(() => createMediaService([kie, kie]), /Duplicate/);
});
test('application adapter translates semantic request to Kie fields', async () => {
  const [, { createKieMediaAdapter }] = await modules;
  const adapter = createKieMediaAdapter({ models: [profile], client: fakeClient({ createTask: async value => {
    assert.deepEqual(value, { model: 'native/video', input: { prompt: 'Кот', aspect_ratio: '16:9', image_urls: ['https://example.test/cat'] } });
    return { taskId: 'job' };
  } }) });
  const result = await adapter.submit({ modelId: 'video', prompt: 'Кот', parameters: { aspectRatio: '16:9' }, assets: [{ kind: 'image', role: 'reference', url: 'https://example.test/cat' }] });
  assert.equal(result.state, 'queued'); assert.equal(result.usage.credits, null);
  assert.equal(adapter.listModels()[0].providerModel, undefined);
});
test('application owns source roles and unique upload filenames', async () => {
  const [, { createKieMediaAdapter }] = await modules;
  const names = [];
  const adapter = createKieMediaAdapter({ uploadPath: 'app-inputs', client: fakeClient({ uploadFile: async value => {
    assert.equal(value.uploadPath, 'app-inputs'); assert.equal(await value.file.text(), 'image');
    names.push(value.fileName); return { downloadUrl: 'https://example.test/source' };
  } }) });
  const asset = { kind: 'image', role: 'reference', bytes: Buffer.from('image'), name: 'cat.png', mimeType: 'image/png' };
  assert.deepEqual(await adapter.uploadAsset(asset), { kind: 'image', role: 'reference', url: 'https://example.test/source' });
  await adapter.uploadAsset(asset); assert.notEqual(names[0], names[1]);
});
test('application normalizes native states/results and removes raw failure details', async () => {
  const [, { createKieMediaAdapter }] = await modules;
  for (const [native, state] of Object.entries({ waiting: 'queued', queuing: 'queued', generating: 'running', success: 'succeeded', fail: 'failed' })) {
    const adapter = createKieMediaAdapter({ models: [profile], client: fakeClient({ getTask: async value => {
      assert.deepEqual(value, { taskId: 'job' });
      return { taskId: 'job', model: 'native/video', state: native, creditsConsumed: 0, failMsg: 'private', resultJson: '{"resultUrls":["https://example.test/result.mp4"]}' };
    } }) });
    const result = await adapter.getTask(ref);
    assert.equal(result.state, state); assert.equal(result.usage.credits, 0);
    assert.equal(result.outputs.length, native === 'success' ? 1 : 0);
    assert.equal(JSON.stringify(result).includes('private'), false);
  }
});
test('application rejects unsupported fields and malformed results', async () => {
  const [, { createKieMediaAdapter }] = await modules;
  const adapter = createKieMediaAdapter({ models: [profile], client: fakeClient({ createTask: () => assert.fail() }) });
  await assert.rejects(adapter.submit({ modelId: 'video', prompt: 'x', parameters: { unlisted: true } }), { code: 'INVALID_REQUEST' });
  for (const data of [{ taskId: 'job', state: 'future' }, { taskId: 'wrong', state: 'waiting' }, { taskId: 'job', state: 'success', resultJson: 'broken' }]) {
    await assert.rejects(createKieMediaAdapter({ models: [profile], client: fakeClient({ getTask: async () => data }) }).getTask(ref), { code: 'INVALID_RESPONSE' });
  }
});
test('application preserves ambiguous provider error without resubmission', async () => {
  const [{ MediaProviderError }, { createKieMediaAdapter }] = await modules;
  let count = 0;
  const adapter = createKieMediaAdapter({ models: [profile], client: fakeClient({ createTask: async () => {
    count++; throw Object.assign(Error('private credential'), { code: 'TRANSPORT_ERROR', outcome: 'unknown' });
  } }) });
  await assert.rejects(adapter.submit({ modelId: 'video', prompt: 'x' }), error => {
    assert.ok(error instanceof MediaProviderError); assert.equal(error.outcome, 'unknown');
    assert.equal(error.message.includes('credential'), false); return true;
  });
  assert.equal(count, 1);
});
