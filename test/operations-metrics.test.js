const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { openDatabase } = require('../src/database/database');
const { testPool } = require('./helpers/pg-pool');
const { operationsMetrics, operationsAlerts } = require('../src/services/operations-metrics');

test('operations metrics expose held and unknown work without account data', async t => {
  const pool = await openDatabase({}, testPool());
  t.after(() => pool.end());
  const accountId = randomUUID();
  await pool.query("INSERT INTO media_accounts(id,display_name) VALUES($1,'Metrics')", [accountId]);
  await pool.query("INSERT INTO media_reservations(job_id,account_id,amount,price_version,state) VALUES($1,$2,100,'v1','held')", [randomUUID(), accountId]);
  await pool.query('INSERT INTO media_records(account_id,namespace,id,data) VALUES($1,$2,$3,$4)',
    [accountId, 'history', randomUUID(), JSON.stringify({ state: 'unknown' })]);
  const paymentId = randomUUID();
  await pool.query(`INSERT INTO payment_payments(id,client_id,environment,external_order_id,amount_minor,currency,status,resolution,created_at,updated_at)
    VALUES($1,$2,'test',$3,100,'RUB','created','unknown',now()-interval '24 hours',now()-interval '24 hours')`,
  [paymentId, accountId, randomUUID()]);
  await pool.query(`INSERT INTO payment_commands(id,operation,client_id,environment,idempotency_key,payload_hash,payment_id,created_at)
    VALUES($1,'create',$2,'test',$3,$4,$5,now()-interval '24 hours')`,
  [randomUUID(), accountId, randomUUID(), 'a'.repeat(64), paymentId]);
  const result = await operationsMetrics(pool);
  assert.equal(result.reservations.held, 1);
  assert.equal(result.generation.unknown, 1);
  assert.equal(result.content.backlog, 0);
  assert.equal(result.payments.outbox_backlog, 0);
  assert.equal(result.payments.expired_unknown_commands, 1);
  assert.ok(result.payments.oldest_unknown_seconds >= 23 * 3600);
  assert.deepEqual(result.alerts.filter(item => item.severity === 'critical').map(item => item.code),
    ['PAYMENT_UNKNOWN_OLD', 'PAYMENT_COMMAND_REVIEW']);
  assert.equal(JSON.stringify(result).includes(accountId), false);
});

test('operations alerts trigger only after the documented age thresholds', () => {
  const metrics = {
    reservations: { oldest_held_seconds: 3599 }, generation: { oldest_unknown_seconds: 1799 },
    content: { failed: 0, oldest_backlog_seconds: 899 },
    payments: { oldest_outbox_seconds: 299, oldest_webhook_seconds: 299, oldest_unknown_seconds: 899, expired_unknown_commands: 0 },
  };
  assert.deepEqual(operationsAlerts(metrics), []);
  metrics.content.oldest_backlog_seconds = 900;
  metrics.payments.oldest_outbox_seconds = 300;
  assert.deepEqual(operationsAlerts(metrics), [
    { code: 'CONTENT_BACKLOG_OLD', severity: 'warning' },
    { code: 'PAYMENT_OUTBOX_OLD', severity: 'critical' },
  ]);
});
