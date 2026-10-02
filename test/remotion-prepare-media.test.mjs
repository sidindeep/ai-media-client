import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareMovieMedia } from '../web/src/remotion/prepare-media.mts';

const props = () => ({ scenes: [{ id: 'a', kind: 'image', src: '/api/content/photo', title: '', seconds: 5 },
  { id: 'b', kind: 'video', src: '/api/content/clip', title: '', seconds: 5 },
  { id: 'c', kind: 'video', src: '/api/content/clip', title: '', seconds: 5 }], music: '/api/content/music', background: '#000000', muteClips: false });

test('export downloads complete sources once, preserves draft refs and releases local copies', async () => {
  const draft = props(), before = structuredClone(draft), requests = [], progress = [];
  const prepared = await prepareMovieMedia(draft, new AbortController().signal, (done, total) => progress.push([done, total]),
    async (src, init) => { requests.push(src); assert.equal(init.credentials, 'same-origin'); assert.equal(init.headers, undefined); return new Response(src); });
  assert.deepEqual(draft, before);
  assert.deepEqual(requests, ['/api/content/photo', '/api/content/clip', '/api/content/music']);
  assert.deepEqual(progress, [[0, 3], [1, 3], [2, 3], [3, 3]]);
  assert.equal(prepared.props.scenes[1].src, prepared.props.scenes[2].src);
  const url = prepared.props.scenes[0].src;
  assert.equal(await (await fetch(url)).text(), draft.scenes[0].src);
  prepared.dispose(); prepared.dispose();
  await assert.rejects(fetch(url), { name: 'TypeError' });
});
test('failed source read releases already prepared files and stops fetching', async () => {
  const draft = props(); let firstUrl, count = 0;
  const create = URL.createObjectURL;
  URL.createObjectURL = blob => { firstUrl = create(blob); return firstUrl; };
  try {
    await assert.rejects(prepareMovieMedia(draft, new AbortController().signal, undefined, async () => {
      count++; if (count === 2) return new Response('', { status: 403 }); return new Response('photo');
    }), /HTTP 403/);
    assert.equal(count, 2);
    await assert.rejects(fetch(firstUrl), { name: 'TypeError' });
  } finally { URL.createObjectURL = create; }
});
test('cancellation aborts the active download before opening another source', async () => {
  const controller = new AbortController(); let count = 0;
  await assert.rejects(prepareMovieMedia(props(), controller.signal, undefined, async (src, init) => {
    count++;
    return new Promise((resolve, reject) => { init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }); controller.abort(); });
  }), { name: 'AbortError' });
  assert.equal(count, 1);
});
test('oversized and external sources are rejected before rendering', async () => {
  await assert.rejects(prepareMovieMedia(props(), new AbortController().signal, undefined,
    async () => new Response('', { headers: { 'content-length': String(101 * 1024 * 1024) } })), /MOVIE_FILE_TOO_LARGE/);
  const draft = props(); draft.scenes[0].src = 'https://external.test/private';
  await assert.rejects(prepareMovieMedia(draft, new AbortController().signal, undefined, () => { throw new Error('Must not fetch'); }), /SCENE_SOURCE/);
});
