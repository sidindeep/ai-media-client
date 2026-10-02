import test from 'node:test';
import assert from 'node:assert/strict';
import { checkMovieMedia, MovieMediaError } from '../web/src/remotion/media-check.mts';

const props = (extra = {}) => ({ scenes: [{ kind: 'title' }, { kind: 'video', src: '/api/content/video' }], muteClips: false, ...extra });
function input(video = true, audio = true) {
  return { getPrimaryVideoTrack: async () => ({ canDecode: async () => video }),
    getPrimaryAudioTrack: async () => ({ canDecode: async () => audio }), dispose() { this.disposed = true; } };
}
test('export rejects an undecodable video with its scene number and frees the reader', async () => {
  const reader = input(false);
  await assert.rejects(checkMovieMedia(props(), new AbortController().signal, () => reader),
    error => error instanceof MovieMediaError && error.scene === 2 && error.kind === 'video');
  assert.equal(reader.disposed, true);
});
test('muting bypasses incompatible clip audio while preserving the video check', async () => {
  await assert.rejects(checkMovieMedia(props(), new AbortController().signal, () => input(true, false)), { kind: 'audio', scene: 2 });
  await checkMovieMedia(props({ muteClips: true }), new AbortController().signal, () => input(true, false));
});
test('supported repeated media is checked once and background music is checked even with muted clips', async () => {
  let opened = 0;
  const p = props(); p.scenes.push(p.scenes[1]);
  await checkMovieMedia(p, new AbortController().signal, () => { opened++; return input(); });
  assert.equal(opened, 1);
  await assert.rejects(checkMovieMedia(props({ music: '/api/content/music', muteClips: true }), new AbortController().signal,
    src => input(true, src.endsWith('music') ? false : true)), { kind: 'audio', scene: 0 });
});
test('cancelled export does not open more readers', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(checkMovieMedia(props(), controller.signal, () => { throw new Error('Reader should not open'); }), { name: 'AbortError' });
});
