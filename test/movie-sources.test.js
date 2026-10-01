const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMovieSources, sourceUrl, mediaType, MAX_FILE_BYTES } = require('../src/services/movie-sources');
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const signal = () => AbortSignal.timeout(5000);
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);

test('public folder import blocks local addresses and unsupported protocols', () => {
  for (const value of ['http://example.com/file.png', 'https://127.0.0.1/a.png', 'https://10.0.0.1/a.png', 'https://[::1]/a.png', 'https://example.local/a.png', 'https://user:password@example.com/a.png', 'https://example.com:3210/a.png'])
    assert.throws(() => sourceUrl(value));
  assert.equal(mediaType('CLIP.MP4', 'video/quicktime'), 'video/mp4');
  assert.equal(mediaType('photo.png', 'text/html'), undefined);
});
test('Yandex pagination, nested photo/video, ticket ownership and download URLs', async () => {
  const calls = [];
  const service = createMovieSources({ fetchImpl: async value => {
    const url = new URL(value); calls.push(url);
    if (url.hostname === 'cdn.example.com') return new Response(png, { headers: { 'Content-Type': 'image/png' } });
    if (url.pathname.endsWith('/download')) return json({ href: 'https://cdn.example.com/photo.png' });
    if (url.searchParams.get('path') === '/nested') return json({ type: 'dir', _embedded: { total: 1, items: [{ type: 'file', path: '/nested/photo.png', name: 'фото.png', mime_type: 'image/png', size: 9 }] } });
    if (url.searchParams.get('offset') === '100') return json({ type: 'dir', _embedded: { total: 101, items: [{ type: 'file', path: '/clip.mp4', name: 'clip.mp4', mime_type: 'video/mp4', size: 30 }] } });
    return json({ type: 'dir', _embedded: { total: 101, items: [{ type: 'dir', path: '/nested' }, { type: 'file', path: '/large.mp4', name: 'large.mp4', mime_type: 'video/mp4', size: MAX_FILE_BYTES + 1 }] } });
  } });
  const result = await service.list('owner', 'https://disk.yandex.ru/d/public', 20, signal());
  assert.deepEqual(result.files.map(file => file.type), ['image/png', 'video/mp4']);
  assert.equal(result.skipped, 1);
  assert.ok(!JSON.stringify(result).includes('cdn.example'));
  await assert.rejects(service.download('other', result.files[0].id, signal()), { status: 404 });
  assert.deepEqual((await service.download('owner', result.files[0].id, signal())).bytes, png);
  assert.equal(calls.find(url => url.pathname.endsWith('/download')).searchParams.get('path'), '/nested/photo.png');
  const limited = await service.list('owner', 'https://disk.yandex.ru/d/public', 1, signal());
  assert.equal(limited.files.length, 1); assert.equal(limited.truncated, true);
  await assert.rejects(service.download('owner', result.files[0].id, signal()), { status: 404 });
});
test('Google uses API key, pagination, resource keys and nested folders', async () => {
  const calls = [];
  const service = createMovieSources({ googleApiKey: 'test-key', fetchImpl: async (value, _signal, headers) => {
    const url = new URL(value); calls.push({ url, headers });
    if (url.searchParams.get('alt') === 'media') return new Response(png, { headers: { 'Content-Type': 'image/png' } });
    if (url.searchParams.get('q').includes('nested')) return json({ files: [{ id: 'photo', name: 'test.png', mimeType: 'image/png', resourceKey: 'photo-key', size: '9' }] });
    if (url.searchParams.get('pageToken')) return json({ files: [{ id: 'video', name: 'test.mp4', mimeType: 'video/mp4', size: '30' }] });
    return json({ nextPageToken: 'page2', files: [{ id: 'nested', mimeType: 'application/vnd.google-apps.folder', resourceKey: 'nested-key' }] });
  } });
  const result = await service.list('owner', 'https://drive.google.com/drive/folders/root?resourcekey=root-key', 20, signal());
  assert.equal(result.files.length, 2);
  assert.equal(calls[0].headers['X-Goog-Drive-Resource-Keys'], 'root/root-key');
  assert.equal(calls[0].url.searchParams.get('key'), 'test-key');
  await service.download('owner', result.files[0].id, signal());
  assert.equal(calls.at(-1).headers['X-Goog-Drive-Resource-Keys'], 'photo/photo-key');
  assert.ok(!JSON.stringify(result).includes('test-key'));
  await assert.rejects(createMovieSources({ googleApiKey: '' }).list('owner', 'https://drive.google.com/drive/folders/root', 20, signal()), { code: 'MOVIE_GOOGLE_CONFIG' });
});
test('other providers: JSON manifests, HTML directories, redirects, byte limits and fake media', async () => {
  const service = createMovieSources({ fetchImpl: async value => {
    const url = new URL(value);
    if (url.pathname === '/manifest') return json({ files: [{ url: './test.png', name: 'фото.png' }, 'https://127.0.0.1/file.png', './clip.webm'] });
    if (url.pathname === '/directory') return new Response('<a href="test.png">photo</a><a href="clip.webm">video</a><a href="file.txt">text</a>', { headers: { 'Content-Type': 'text/html' } });
    if (url.pathname === '/test.png') return new Response(png, { headers: { 'Content-Type': 'image/png' } });
    if (url.pathname === '/fake.png') return new Response('<html>sign in</html>', { headers: { 'Content-Type': 'application/octet-stream' } });
    if (url.pathname === '/large.mp4') return new Response('a', { headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(MAX_FILE_BYTES + 1) } });
    return new Response(null, { status: 302, headers: { Location: 'https://127.0.0.1/private' } });
  } });
  const list = await service.list('owner', 'https://example.com/manifest', 20, signal());
  assert.equal(list.files.length, 2); assert.equal(list.skipped, 1);
  assert.deepEqual((await service.download('owner', list.files[0].id, signal())).bytes, png);
  assert.equal((await service.list('owner', 'https://example.com/directory', 20, signal())).files.length, 2);
  for (const [name, code] of [['fake.png', 'MOVIE_SOURCE_TYPE'], ['large.mp4', 'MOVIE_SOURCE_SIZE'], ['redirect.png', 'MOVIE_SOURCE_URL']]) {
    const result = await service.list('owner', `https://example.com/${name}`, 20, signal());
    await assert.rejects(service.download('owner', result.files[0].id, signal()), { code });
  }
});
test('import concurrency is bounded and released after failure', async () => {
  const service = createMovieSources(); let release;
  const running = service.run('owner', () => new Promise(resolve => { release = resolve; }));
  await assert.rejects(service.run('owner', async () => {}), { status: 429 });
  release(); await running;
  await assert.rejects(service.run('owner', async () => { throw new Error('failed'); }), /failed/);
  assert.equal(await service.run('owner', async () => 'ready'), 'ready');
});
