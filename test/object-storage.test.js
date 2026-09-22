const test = require('node:test');
const assert = require('node:assert/strict');
const { createObjectStorage } = require('../src/object-storage');

test('S3 storage scopes commands to the configured private bucket', async () => {
  const calls = [];
  const body = { transformToByteArray: async () => Uint8Array.from([1, 2, 3]) };
  const client = { async send(command) {
    calls.push({ name: command.constructor.name, input: command.input });
    if (command.constructor.name === 'HeadObjectCommand') return { ContentLength: 3, ContentType: 'image/png' };
    if (command.constructor.name === 'GetObjectCommand') return { Body: body, ContentLength: 3, ContentType: 'image/png', ContentRange: command.input.Range ? 'bytes 1-2/3' : undefined };
    if (command.constructor.name === 'ListObjectsV2Command' && command.input.Prefix) return { Contents: [{ Key: 'accounts/a/source.png', Size: 3 }] };
    return {};
  } };
  const storage = createObjectStorage({ enabled: true, bucket: 'private-media' }, client);
  await storage.check();
  await storage.put('accounts/a/source.png', Buffer.from('x'), 'image/png');
  assert.deepEqual(await storage.head('accounts/a/source.png'), { size: 3, type: 'image/png' });
  assert.deepEqual(await storage.read('accounts/a/source.png'), Buffer.from([1, 2, 3]));
  assert.equal((await storage.stream('accounts/a/source.png', 'bytes=1-2')).contentRange, 'bytes 1-2/3');
  assert.deepEqual(await storage.list('accounts/a/'), [{ key: 'accounts/a/source.png', size: 3 }]);
  assert.ok(calls.every(call => call.input.Bucket === 'private-media'));
  assert.deepEqual(calls.map(call => call.name), ['ListObjectsV2Command', 'PutObjectCommand', 'HeadObjectCommand', 'GetObjectCommand', 'GetObjectCommand', 'ListObjectsV2Command']);
});

test('object storage stays disabled without S3 configuration', () => {
  assert.equal(createObjectStorage({ enabled: false }), null);
});
