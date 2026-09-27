const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { randomUUID } = require('node:crypto');
const { openDatabase } = require('../src/database/database');
const { grantRuntimeRole } = require('../src/database/runtime-grants');

test('a DML-only PostgreSQL role starts the application and cannot change schema',
  { skip: !process.env.TEST_DATABASE_URL }, async t => {
    const admin = await openDatabase({}, new Pool({ connectionString: process.env.TEST_DATABASE_URL }));
    const role = `media_test_${randomUUID().replace(/-/g, '')}`;
    await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'test-only-password'`);
    const runtime = new Pool({ connectionString: process.env.TEST_DATABASE_URL.replace('test:test@', `${role}:test-only-password@`) });
    t.after(async () => { await runtime.end(); await admin.query(`DROP OWNED BY "${role}"`); await admin.query(`DROP ROLE "${role}"`); await admin.end(); });
    await grantRuntimeRole(admin, role);
    await openDatabase({ migrate: false }, runtime);
    const accountId = randomUUID();
    await runtime.query("INSERT INTO media_accounts(id,display_name) VALUES($1,'Restricted')", [accountId]);
    assert.equal((await runtime.query('SELECT id FROM media_accounts WHERE id=$1', [accountId])).rows[0].id, accountId);
    await assert.rejects(runtime.query('CREATE TABLE runtime_must_not_create(id integer)'), error => error.code === '42501');
  });
