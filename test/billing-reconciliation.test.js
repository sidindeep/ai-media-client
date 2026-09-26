const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { testPool } = require('./helpers/pg-pool');
const { transaction } = require('../src/database/database');
const { reserve, settle } = require('../src/billing/wallet');
const { billingReconciliation } = require('../src/services/billing-reconciliation');

test('billing reconciliation separates confirmed mismatch, possible cost and held unknown', async t => {
  const pool = testPool();
  t.after(() => pool.end());
  await pool.query(await fs.readFile(path.join(__dirname, '../src/database/schema.sql'), 'utf8'));
  const account = randomUUID();
  await pool.query('INSERT INTO media_accounts(id,display_name) VALUES($1,$2)', [account, 'Test account']);
  await pool.query('INSERT INTO media_wallets(account_id,balance) VALUES($1,100000)', [account]);
  for (const jobId of ['charged', 'sent', 'unsent', 'free', 'partial', 'held']) {
    await transaction(pool, async client => {
      await reserve(client, account, jobId, { amountUnits: 1000, version: 'v1' });
      if (jobId === 'partial') await settle(client, account, jobId, 'success', { state: 'success' }, 500);
      else if (jobId !== 'held') await settle(client, account, jobId, 'fail', { state: 'fail' });
    });
  }
  for (const [jobId, record] of Object.entries({
    charged: { state: 'fail', taskId: 'provider-charged', creditsConsumed: 2 },
    sent: { state: 'fail', taskId: 'provider-sent' },
    unsent: { state: 'cancelled' },
    free: { state: 'success', taskId: 'provider-free', creditsConsumed: 0 },
    partial: { state: 'success', taskId: 'provider-partial', creditsConsumed: 2 },
    held: { state: 'unknown' },
  })) await pool.query("INSERT INTO media_records(account_id,namespace,id,data) VALUES($1,'history',$2,$3)", [account, jobId, JSON.stringify(record)]);
  const result = await billingReconciliation(pool, 30);
  assert.deepEqual(result.summary, { confirmedMismatch: 1, releasedAfterSend: 1, heldUnknown: 1, reviewReleasedUnits: 2000 });
  assert.deepEqual(result.incidents.map(item => [item.jobId, item.risk]), [
    ['charged', 'confirmed_mismatch'], ['sent', 'released_after_send'], ['held', 'held_unknown'],
  ]);
  assert.equal(result.incidents[0].providerCostUnit, 'Kie credits');
  await assert.rejects(billingReconciliation(pool, 365), /Некорректный период/);
});
