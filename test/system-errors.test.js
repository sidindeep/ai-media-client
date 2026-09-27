const test = require('node:test');
const assert = require('node:assert/strict');
const errors = require('../src/system-errors');
const trace = require('../src/generation-log');
const { openDatabase } = require('../src/database/database');
const { testPool } = require('./helpers/pg-pool');

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

test('system error retention removes only rows older than 90 days in bounded batches', async t => {
  const pool = await openDatabase({}, testPool());
  t.after(() => pool.end());
  await pool.query(`INSERT INTO media_system_errors(source,event,message,occurred_at) VALUES
    ('test','old','old',now()-interval '91 days'),('test','new','new',now()-interval '89 days')`);
  assert.equal(await errors.pruneOld(pool, 90, 1), 1);
  assert.deepEqual((await pool.query('SELECT event FROM media_system_errors ORDER BY id')).rows.map(row => row.event), ['new']);
});
