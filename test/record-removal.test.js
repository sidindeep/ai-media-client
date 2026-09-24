const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { testPool } = require('./helpers/pg-pool');
const { openDatabase } = require('../src/database/database');
const { AccountRecords } = require('../src/database/records');

test('record deletion releases only unsent reservations and preserves provider-submitted work', async t => {
  const pool = await openDatabase({}, testPool());
  t.after(() => pool.end());
  const accountId = randomUUID();
  await pool.query("INSERT INTO media_accounts(id,display_name) VALUES($1,'Queue removal')", [accountId]);
  await pool.query('INSERT INTO media_wallets(account_id,balance) VALUES($1,10000)', [accountId]);
  const records = new AccountRecords(pool, accountId, 'history');
  const quote = { amountUnits: 2500, version: 'test-v1' };

  await records.update('unsent', { state: 'queued', nativeQuote: quote });
  assert.equal((await pool.query('SELECT held FROM media_wallets WHERE account_id=$1', [accountId])).rows[0].held, 2500);
  await records.remove('unsent', 'cancelled');
  assert.equal((await records.list()).length, 0);
  assert.deepEqual((await pool.query('SELECT balance,held FROM media_wallets WHERE account_id=$1', [accountId])).rows[0], { balance: 10000, held: 0 });

  await records.update('submitted', { state: 'waiting', nativeQuote: quote });
  assert.equal(await records.remove('submitted', 'cancelled', ['queued']), null);
  assert.equal((await records.list())[0].state, 'waiting');
  assert.equal((await pool.query('SELECT held FROM media_wallets WHERE account_id=$1', [accountId])).rows[0].held, 2500);
  assert.equal(await records.remove('submitted', 'success', ['waiting']), null);
  assert.equal((await records.list()).length, 1);
  await records.update('submitted', { taskId: 'provider-job', state: 'generating', creditsConsumed: 5.5 });
  assert.ok((await records.list())[0].providerChargeConfirmedAt);
  assert.deepEqual((await pool.query('SELECT balance,held FROM media_wallets WHERE account_id=$1', [accountId])).rows[0], { balance: 7500, held: 0 });
  await records.update('submitted', { state: 'fail' });
  assert.deepEqual((await pool.query('SELECT kind FROM media_ledger WHERE account_id=$1 ORDER BY created_at', [accountId])).rows.map(row => row.kind), ['reserve', 'release', 'reserve', 'capture']);

  await records.update('unpriced', { state: 'queued', nativeQuote: { status: 'unavailable', amountUnits: null } });
  await records.update('unpriced', { state: 'success' });
  assert.equal((await pool.query('SELECT count(*) AS count FROM media_reservations WHERE job_id=$1', ['unpriced'])).rows[0].count, 0);
  assert.deepEqual((await pool.query('SELECT balance,held FROM media_wallets WHERE account_id=$1', [accountId])).rows[0], { balance: 7500, held: 0 });

  await records.update('free', { state: 'queued', nativeQuote: quote });
  await records.update('free', { state: 'success', taskId: 'free-provider-job', creditsConsumed: 0 });
  assert.ok((await records.list()).find(row => row.id === 'free').providerFreeConfirmedAt);
  assert.deepEqual((await pool.query('SELECT balance,held FROM media_wallets WHERE account_id=$1', [accountId])).rows[0], { balance: 7500, held: 0 });
});
