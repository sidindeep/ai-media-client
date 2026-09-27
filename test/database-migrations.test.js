const test = require('node:test');
const assert = require('node:assert/strict');
const { testPool } = require('./helpers/pg-pool');
const { openDatabase } = require('../src/database/database');

test('schema migrates once and a runtime connection needs no DDL', async t => {
  const pool = await openDatabase({}, testPool());
  t.after(() => pool.end());
  const versions = (await pool.query('SELECT version FROM media_schema_versions ORDER BY version')).rows.map(row => row.version);
  assert.equal(versions.at(-1), 13);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM media_schema_migrations')).rows[0].count, 4);
  const readonly = { ...pool, async connect() {
    const client = await pool.connect();
    return { release: () => client.release(), query: (sql, params) => {
      if (/\b(?:CREATE|ALTER|DROP)\b/i.test(sql)) throw new Error('Runtime attempted DDL');
      return client.query(sql, params);
    } };
  } };
  await openDatabase({ migrate: false }, readonly);
});
