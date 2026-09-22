const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Assets } = require('../src/assets');

test('concurrent generations share one provider upload for the same source', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-media-assets-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const assets = new Assets(directory);
  const saved = await assets.save({ bytes: Buffer.from('same-image'), name: 'source.png', type: 'image/png' });
  let uploads = 0;
  let releaseUpload;
  const uploadGate = new Promise(resolve => { releaseUpload = resolve; });
  const upload = async () => { uploads += 1; await uploadGate; return 'https://example.test/source.png'; };
  const input = { image_urls: [saved.ref] };

  const first = assets.resolve(input, [saved], upload);
  const second = assets.resolve(input, [saved], upload);
  while (uploads === 0) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(uploads, 1);
  releaseUpload();
  assert.deepEqual(await first, await second);
  assert.deepEqual(await assets.resolve(input, [saved], async () => { uploads += 1; return 'https://example.test/fresh.png'; }), { image_urls: ['https://example.test/fresh.png'] });
  assert.equal(uploads, 2);
});

test('assets use a tenant-scoped object key when shared storage is enabled', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-media-assets-s3-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const objects = new Map();
  const storage = {
    async put(key, bytes, type) { objects.set(key, { bytes: Buffer.from(bytes), type }); },
    async read(key) { return objects.get(key).bytes; },
  };
  const assets = new Assets(directory, { storage, prefix: 'accounts/account-1' });
  const saved = await assets.save({ bytes: Buffer.from('shared-image'), name: 'source.png', type: 'image/png' });
  const id = assets.id(saved.ref);
  assert.equal(assets.key(id), `accounts/account-1/sources/${id}`);
  assert.equal(objects.get(assets.key(id)).type, 'image/png');
  assert.deepEqual(await assets.resolve({ image: saved.ref }, [saved], async file => file.bytes.toString()), { image: 'shared-image' });
});
