import test from 'node:test';
import assert from 'node:assert/strict';
import { FPS, timeline } from '../web/src/remotion/model.mjs';
const title = (seconds = 2) => ({ id: 'a', kind: 'title', title: 'Титр', seconds });
test('timeline schedules contiguous scenes and rounds to frames', () => {
  const plan = timeline([title(1.5), { ...title(2), id: 'b' }]);
  assert.equal(plan.scenes[1].from, 45);
  assert.equal(plan.durationInFrames, 3.5 * FPS);
});
test('timeline rejects invalid, excessive and unsafe input', () => {
  for (const scenes of [[], [title(NaN)], [title(0)], [title(31)], Array(21).fill(title()), Array(5).fill(title(30)), [{ ...title(), kind: 'image', src: 'https://external.test/private' }]]) assert.throws(() => timeline(scenes));
  assert.equal(timeline([{ ...title(), kind: 'image', src: '/api/content/owned-asset' }]).durationInFrames, 60);
});
