const test = require('node:test');
const assert = require('node:assert/strict');
const errors = require('../src/system-errors');
const trace = require('../src/generation-log');

test('system errors keep only sanitized error data and survive a temporary database failure', async () => {
  let unavailable = true;
  const rows = [];
  const pool = { async query(sql, values) {
    assert.match(sql, /^INSERT INTO media_system_errors/);
    if (unavailable) throw new Error('database offline');
    rows.push(values);
  } };
  trace.secret('private-test-token');
  errors.setPool(pool);
  errors.record('server', 'example.error', Object.assign(new Error('Bearer private-test-token'), { code: 'TEST' }),
    { url: 'https://example.test/path?token=private-test-token', password: 'private-test-token' });
  await errors.flush();
  assert.equal(rows.length, 0);
  unavailable = false;
  errors.setPool(pool);
  await errors.flush();
  assert.equal(rows.length, 1);
  assert.equal(rows[0][2], 'TEST');
  assert.ok(!JSON.stringify(rows).includes('private-test-token'));
  assert.equal(JSON.parse(rows[0][4]).password, '[REDACTED]');
  errors.setPool(null);
});
