const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { testPool } = require('./helpers/pg-pool');
const { openDatabase } = require('../src/database/database');

test('schema migrates once and a runtime connection needs no DDL', async t => {
  const pool = await openDatabase({}, testPool());
  t.after(() => pool.end());
  const versions = (await pool.query('SELECT version FROM media_schema_versions ORDER BY version')).rows.map(row => row.version);
  assert.equal(versions.at(-1), 13);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM media_schema_migrations')).rows[0].count, 4);
  const baseline = await fs.readFile(path.join(__dirname, '../src/database/schema.sql'), 'utf8');
  const canonicalHash = createHash('sha256').update(baseline.replace(/\r\n?/g, '\n')).digest('hex');
  assert.equal(canonicalHash, '0c2ffc1f6a780051be243168cb3d145de02ff355c54ea6d2af82e9ab49069cb6');
  const legacyWindowsHash = createHash('sha256').update(baseline.replace(/\r\n?|\n/g, '\r\n')).digest('hex');
  await pool.query('UPDATE media_schema_migrations SET checksum=$1 WHERE version=10', [legacyWindowsHash]);
  const readonly = { ...pool, async connect() {
    const client = await pool.connect();
    return { release: () => client.release(), query: (sql, params) => {
      if (/\b(?:CREATE|ALTER|DROP)\b/i.test(sql)) throw new Error('Runtime attempted DDL');
      return client.query(sql, params);
    } };
  } };
  await openDatabase({ migrate: false }, readonly);
  await pool.query('UPDATE media_schema_migrations SET checksum=$1 WHERE version=10', ['579167d62b3350f35b14c05218ff57e3b68fbc038b016054cd9102fa41834553']);
  await openDatabase({ migrate: false }, readonly);
});

test('migration journal still rejects changed SQL', async () => {
  const pool = await openDatabase({}, testPool());
  await pool.query('UPDATE media_schema_migrations SET checksum=$1 WHERE version=10', ['f'.repeat(64)]);
  await assert.rejects(openDatabase({ migrate: false }, pool), { code: 'DATABASE_MIGRATION_CHANGED' });
});
