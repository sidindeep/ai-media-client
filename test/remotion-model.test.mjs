import test from 'node:test';
import assert from 'node:assert/strict';
import { FPS, timeline, splitScene, trimScene, musicEditing } from '../web/src/remotion/model.mjs';
const title = (seconds = 2) => ({ id: 'a', kind: 'title', title: 'Титр', seconds });
test('timeline overlaps scenes for a half-second crossfade without shortening their content', () => {
  const plan = timeline([title(1.5), { ...title(2), id: 'b' }]);
  assert.equal(plan.scenes[1].from, 30);
  assert.equal(plan.scenes[0].durationInFrames, 45);
  assert.equal(plan.scenes[0].fadeOut, 15);
  assert.equal(plan.scenes[1].fadeIn, 15);
  assert.equal(plan.durationInFrames, 3 * FPS);
});
test('timeline rejects invalid, excessive and unsafe input', () => {
  for (const scenes of [[], [title(NaN)], [title(0)], [title(31)], Array(21).fill(title()), Array(2).fill({ ...title(400), kind: 'video', src: '/api/content/clip' }), [{ ...title(), kind: 'image', src: 'https://external.test/private' }]]) assert.throws(() => timeline(scenes));
  assert.equal(timeline([{ ...title(), kind: 'image', src: '/api/content/owned-asset' }]).durationInFrames, 60);
});
test('full videos longer than 30 seconds and subsecond clips retain their duration', () => {
  const clip = seconds => ({ ...title(seconds), kind: 'video', src: '/api/content/clip' });
  assert.equal(timeline([clip(95)]).durationInFrames, 95 * FPS);
  const plan = timeline([clip(1 / FPS), clip(2 / FPS)]);
  assert.equal(plan.durationInFrames, 3);
  assert.equal(plan.scenes[1].from, 1);
});

test('trim and split preserve exact source ranges, caption windows and outer fades', () => {
  const clip = { id: 'video', kind: 'video', src: '/api/content/clip', title: 'Caption', seconds: 6, sourceDuration: 12,
    trimStart: 2, captionStart: 1, captionEnd: 5, audioFadeIn: 0.5, audioFadeOut: 0.8, transition: 'slide', transitionSeconds: 0.7 };
  const [left, right] = splitScene(clip, 2, 'right');
  assert.deepEqual([left.trimStart, left.seconds, right.trimStart, right.seconds], [2, 2, 4, 4]);
  assert.deepEqual([left.captionStart, left.captionEnd, right.captionStart, right.captionEnd], [1, 2, 0, 3]);
  assert.deepEqual([left.audioFadeIn, left.audioFadeOut, right.audioFadeIn, right.audioFadeOut], [0.5, 0, 0, 0.8]);
  assert.equal(left.transition, 'cut'); assert.equal(right.transition, 'slide');
  assert.equal(timeline([left, right]).durationInFrames, 180);
  assert.equal(trimScene(clip, 3, 5).seconds, 2);
  for (const at of [0, 6, NaN]) assert.throws(() => splitScene(clip, at, 'right'));
  for (const [start, end] of [[-1, 3], [3, 3], [10, 13]]) assert.throws(() => trimScene(clip, start, end));
});

test('selected transition controls overlaps, while invalid editing settings are rejected', () => {
  const cut = timeline([{ ...title(2), transition: 'cut' }, { ...title(2), id: 'b' }]);
  assert.equal(cut.durationInFrames, 120); assert.equal(cut.scenes[1].from, 60);
  const slide = timeline([{ ...title(2), transition: 'slide', transitionSeconds: 1 }, { ...title(2), id: 'b' }]);
  assert.equal(slide.durationInFrames, 90); assert.equal(slide.scenes[1].incomingTransition, 'slide');
  for (const patch of [{ volume: 2 }, { trimStart: -1 }, { transition: 'unknown' }, { scale: Infinity }, { captionColor: 'url(evil)' }, { captionStart: 1.5, captionEnd: 1 }])
    assert.throws(() => timeline([{ ...title(2), ...patch }]));
  assert.equal(musicEditing().volume, 0.7);
  assert.throws(() => musicEditing({ start: -1 }));
});
