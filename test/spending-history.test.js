const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { testPool } = require('./helpers/pg-pool');
const { transaction } = require('../src/database/database');
const { reserve, settle } = require('../src/billing/wallet');
const { spendingHistory } = require('../src/services/spending-history');

test('spending counts captures and releases separately with account filters and stable pages', async t => {
  const pool = testPool();
  t.after(() => pool.end());
  await pool.query(await fs.readFile(path.join(__dirname, '../src/database/schema.sql'), 'utf8'));
  const account = randomUUID(), other = randomUUID();
  for (const id of [account, other]) {
    await pool.query('INSERT INTO media_accounts(id,display_name) VALUES($1,$2)', [id, id]);
    await pool.query('INSERT INTO media_wallets(account_id,balance) VALUES($1,100000)', [id]);
  }
  await transaction(pool, async client => {
    await reserve(client, account, 'image-job', { amountUnits: 2500, version: 'v1' });
    await settle(client, account, 'image-job', 'success', { id: 'image-job', kind: 'image', modelName: 'Image model' });
    await reserve(client, account, 'video-job', { amountUnits: 1500, version: 'v1' });
    await settle(client, account, 'video-job', 'fail', { id: 'video-job', kind: 'video', modelName: 'Video model' });
  });
  await pool.query(`INSERT INTO media_ledger(id,account_id,kind,reference,amount,details)
    VALUES($1,$2,'capture','other-job',9999,'{"category":"text"}')`, [randomUUID(), other]);
  const all = await spendingHistory(pool, account, { days: 30, category: 'all' });
  assert.equal(all.summary.spentUnits, 2500);
  assert.equal(all.summary.releasedUnits, 1500);
  assert.equal(all.summary.topCategory, 'image');
  assert.equal(all.items.length, 2);
  assert.equal(all.items.find(item => item.kind === 'capture').modelName, 'Image model');
  assert.equal((await spendingHistory(pool, account, { days: 30, category: 'video' })).summary.spentUnits, 0);
  assert.equal((await spendingHistory(pool, account, { days: 30, category: 'video' })).summary.releasedUnits, 1500);
  assert.equal((await spendingHistory(pool, other, { days: 30, category: 'all' })).summary.spentUnits, 9999);
  await pool.query("UPDATE media_ledger SET created_at=now()-interval '40 days' WHERE reference='image-job'");
  assert.equal((await spendingHistory(pool, account, { days: 30 })).summary.spentUnits, 0);
  for (let index = 0; index < 32; index++) {
    await pool.query(`INSERT INTO media_ledger(id,account_id,kind,reference,amount,details)
      VALUES($1,$2,'capture',$3,1000,'{"category":"text"}')`, [randomUUID(), account, `extra-${index}`]);
  }
  const first = await spendingHistory(pool, account, { days: 30 });
  assert.equal(first.summary.spentUnits, 32000);
  assert.equal(first.items.length, 30);
  assert.ok(first.nextCursor);
  const second = await spendingHistory(pool, account, { days: 30, cursor: first.nextCursor, asOf: first.asOf });
  assert.equal(second.items.length, 3);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 33);
  await assert.rejects(spendingHistory(pool, account, { days: 31 }), /Некорректный фильтр/);
});

test('measured settlement captures actual cost and returns unused hold exactly once', async t => {
  const pool = testPool();
  t.after(() => pool.end());
  await pool.query(await fs.readFile(path.join(__dirname, '../src/database/schema.sql'), 'utf8'));
  const account = randomUUID();
  await pool.query('INSERT INTO media_accounts(id,display_name) VALUES($1,$2)', [account, account]);
  await pool.query('INSERT INTO media_wallets(account_id,balance) VALUES($1,10000)', [account]);
  await transaction(pool, async client => {
    await reserve(client, account, 'bounded-job', { amountUnits: 4000, version: 'v1' });
    await settle(client, account, 'bounded-job', 'success', { id: 'bounded-job', kind: 'image' }, 1300);
    await settle(client, account, 'bounded-job', 'success', { id: 'bounded-job', kind: 'image' }, 1300);
  });
  const wallet = (await pool.query('SELECT balance,held FROM media_wallets WHERE account_id=$1', [account])).rows[0];
  assert.deepEqual(wallet, { balance: 8700, held: 0 });
  const ledger = (await pool.query("SELECT kind,amount FROM media_ledger WHERE reference='bounded-job' ORDER BY kind", [])).rows;
  assert.deepEqual(ledger, [{ kind: 'capture', amount: 1300 }, { kind: 'release', amount: 2700 }, { kind: 'reserve', amount: 4000 }]);
  await transaction(pool, async client => {
    await reserve(client, account, 'over-limit-job', { amountUnits: 1000, version: 'v1' });
    await assert.rejects(settle(client, account, 'over-limit-job', 'success', {}, 1001), /превышает/);
  });
  assert.equal((await pool.query('SELECT held FROM media_wallets WHERE account_id=$1', [account])).rows[0].held, 1000);
});
