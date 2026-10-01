import test from 'node:test';
import assert from 'node:assert/strict';
import { exportFailure } from '../web/src/remotion/export-error.mts';

test('renderer diagnostics preserve only stage and fixed category, never private input', () => {
  assert.equal(exportFailure(new Error('Failed to fetch https://private.test/secret?token=secret'), 'media'), 'media:NETWORK');
  assert.equal(exportFailure(new Error('Cannot decode private-file.mp4'), 'render'), 'render:DECODE');
  assert.equal(exportFailure(new Error('Timed out rendering personal title'), 'render'), 'render:TIMEOUT');
  assert.equal(exportFailure(new Error('Unexpected personal title'), 'output'), 'output:UNKNOWN');
  assert.equal(exportFailure(new DOMException('Private source', 'EncodingError'), 'render'), 'render:ENCODE');
  assert.equal(exportFailure({ message: 'Failed to fetch' }, 'support'), 'support:UNKNOWN');
});
