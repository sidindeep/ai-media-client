const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createKieAccounts } = require('../src/services/kie-accounts');
const { createProviderRouter } = require('../src/services/provider-router');
const { createMediaService } = require('../src/services/media-service');
const { Assets } = require('../src/assets');
const modelId = 'kie:grok-imagine-video-1-5-preview';
const input = { prompt: 'Проверка маршрута', duration: 8, aspect_ratio: '16:9', resolution: '720p' };

async function temporary(t) {
  const root = path.resolve(__dirname, '../artifacts');
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'kie-accounts-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('two Kie accounts retain upload/create/poll identity, replay and restart routing', async t => {
  const directory = await temporary(t), calls = [];
  const provider = await createKieAccounts({ primaryKey: 'test-first', secondaryKey: 'test-second',
    createProvider: async ({ apiKey }) => ({ id: 'kie', isConfigured: () => Boolean(apiKey),
      upload: async () => { calls.push(['upload', apiKey]); return `https://example.test/${apiKey}`; },
      create: async () => { calls.push(['create', apiKey]); return { taskId: 'same-remote-id' }; },
      poll: async (_model, taskId) => { calls.push(['poll', apiKey, taskId]); return { state: 'waiting' }; },
      balance: async () => { calls.push(['balance', apiKey]); return 100; },
    }) });
  const routed = createProviderRouter([provider]);
  let service = await createMediaService({ directory, provider: routed, interval: 60000 });
  t.after(() => service.close());
  // Stop automatic dispatch to inspect the persisted binding before any POST.
  service.queue.schedule = () => {}; service.queue.schedulePoll = () => {};
  const first = await service.createTask({ modelId, input, requestId: 'first' });
  const second = await service.createTask({ modelId, input, requestId: 'second', kieAccountId: 'secondary' });
  assert.equal(first.kieAccountId, 'primary'); assert.equal(second.kieAccountId, 'secondary');
  assert.equal((await service.createTask({ modelId, input, requestId: 'second', kieAccountId: 'secondary' })).id, second.id);
  await assert.rejects(service.createTask({ modelId, input, requestId: 'second' }), /другого аккаунта/);
  await assert.rejects(service.createTask({ modelId, input, kieAccountId: 'other' }), /Неизвестный/);
  assert.deepEqual(calls, []);
  await service.queue.tick();
  assert.deepEqual(calls.filter(row => row[0] === 'create').map(row => row[1]).sort(), ['test-first', 'test-second']);
  await service.queue.pollTick();
  assert.deepEqual(calls.filter(row => row[0] === 'poll').map(row => row[1]).sort(), ['test-first', 'test-second']);
  assert.ok((await service.history.list()).every(row => row.taskId === 'same-remote-id'));
  await service.close();
  calls.length = 0;
  service = await createMediaService({ directory, provider: routed, interval: 60000 });
  await service.close(); // Recovery may poll immediately; no submissions may be repeated.
  await service.queue.pollRecord((await service.history.list()).find(row => row.id === second.id));
  assert.ok(calls.some(row => row[0] === 'poll' && row[1] === 'test-second'));
  assert.equal(calls.some(row => row[0] === 'create'), false);
  calls.length = 0;
  await service.queue.pollRecord({ ...first, kieAccountId: undefined, taskId: 'legacy', state: 'waiting' });
  assert.equal(calls[0][1], 'test-first');
  assert.equal(JSON.stringify(service.catalog()).includes('test-second'), false);
  // Diagnostics must check the selected credential and keep its log separate.
  calls.length = 0;
  const diagnosticService = await createMediaService({ directory: path.join(directory, 'diagnostics'), provider: routed,
    tariffFetcher: async () => ({ ok: true, json: async () => ({ code: 200, data: { pages: 1, records: [
      { modelDescription: 'Grok Imagine Video 1.5 Preview', creditPrice: '2.5', creditUnit: 'per video', anchor: 'https://kie.ai/grok-imagine-video-1-5-preview', interfaceType: 'video', provider: 'Grok' },
    ] } }) }) });
  try {
    await diagnosticService.diagnoseProvider(modelId, input);
    const diagnostics = await diagnosticService.diagnoseProvider(modelId, input, [], 'secondary');
    assert.equal(diagnostics.ok, true);
    assert.match(diagnostics.mechanism.credentials, /KIE_API_KEY_2/);
    assert.ok(diagnostics.recentLogs.every(row => row.kieAccountId === 'secondary'));
    assert.deepEqual(calls, [['balance', 'test-first'], ['balance', 'test-second']]);
  } finally { await diagnosticService.close(); }
  const source = await service.saveSource({ name: 'source.txt', type: 'text/plain', bytes: Buffer.from('source') });
  await service.queue.prepare({ ...second, input: { ...input, prompt: source.ref }, sourceFiles: [source] });
  assert.ok(calls.some(row => row[0] === 'upload' && row[1] === 'test-second'));
});

test('unconfigured second account rejects before enqueue without falling back', async t => {
  const directory = await temporary(t);
  const provider = await createKieAccounts({ primaryKey: 'fake-primary' });
  const service = await createMediaService({ directory, provider });
  t.after(() => service.close());
  await assert.rejects(service.createTask({ modelId, input, kieAccountId: 'secondary' }), /не настроен ключ/);
  assert.deepEqual(await service.history.list(), []);
  assert.deepEqual(provider.listAccounts().map(row => row.configured), [true, false]);
});

test('concurrent uploads are deduplicated within a Kie account only', async t => {
  const directory = await temporary(t), assets = new Assets(directory);
  const source = await assets.save({ name: 'ref.txt', type: 'text/plain', bytes: Buffer.from('same content') });
  let unblock; const gate = new Promise(resolve => { unblock = resolve; });
  let uploads = 0;
  const upload = slot => async () => { uploads++; await gate; return `https://example.test/${slot}`; };
  const operations = [
    assets.resolve({ file: source.ref }, [source], upload('first'), 'primary'),
    assets.resolve({ file: source.ref }, [source], upload('first'), 'primary'),
    assets.resolve({ file: source.ref }, [source], upload('second'), 'secondary'),
  ];
  unblock();
  assert.deepEqual(await Promise.all(operations), [{ file: 'https://example.test/first' }, { file: 'https://example.test/first' }, { file: 'https://example.test/second' }]);
  assert.equal(uploads, 2);
});
