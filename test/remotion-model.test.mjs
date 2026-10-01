import test from 'node:test';
import assert from 'node:assert/strict';
import { FPS, timeline } from '../web/src/remotion/model.mjs';
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
