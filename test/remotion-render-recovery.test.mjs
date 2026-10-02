import test from 'node:test';
import assert from 'node:assert/strict';
import { renderWithRecovery } from '../web/src/remotion/render-recovery.mts';
import { exportFailure } from '../web/src/remotion/export-error.mts';
const recoverable = reason => ['render:TIMEOUT', 'render:DECODE'].includes(exportFailure(reason, 'render'));

test('video decode timeout retries once with native frames and keeps prepared sources', async () => {
  const attempts = []; let retries = 0;
  const result = await renderWithRecovery(async native => {
    attempts.push(native);
    if (!native) throw new Error('Timed out extracting video frame');
    return 'complete MP4';
  }, new AbortController().signal, true, recoverable, () => retries++);
  assert.equal(result, 'complete MP4'); assert.deepEqual(attempts, [false, true]); assert.equal(retries, 1);
});

test('recovery propagates the second failure, unrelated failures and cancellation', async () => {
  for (const [message, hasVideo, count] of [['Decode failed', true, 2], ['EncodingError', true, 1], ['Timed out', false, 1]]) {
    let calls = 0;
    await assert.rejects(renderWithRecovery(async () => { calls++; throw new Error(message); },
      new AbortController().signal, hasVideo, recoverable, () => {}));
    assert.equal(calls, count);
  }
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(renderWithRecovery(async () => { calls++; controller.abort(); throw new Error('Timed out'); },
    controller.signal, true, recoverable, () => {}), { name: 'AbortError' });
  assert.equal(calls, 1);
});
