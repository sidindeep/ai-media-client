const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { randomUUID } = require('node:crypto');
const { openDatabase } = require('../src/database/database');
const { createPayments } = require('../src/payments/service');
const { createFakePaymentProvider } = require('./helpers/payment-provider');

test('real PostgreSQL connections preserve terminal payment under concurrent webhook and reconcile',
  { skip: !process.env.TEST_DATABASE_URL }, async t => {
    const pool = await openDatabase({}, new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }));
    t.after(() => pool.end());
    const provider = createFakePaymentProvider({ behavior: 'pending' });
    const payments = createPayments({ pool, provider });
    const ctx = { clientId: 'concurrency-test', environment: 'test' };
    const payment = await payments.createPayment(ctx, { externalOrderId: randomUUID(), amountMinor: 9900,
      currency: 'RUB', idempotencyKey: randomUUID(), description: 'Concurrency test', returnUrl: 'https://example.test/return' });
    const providerPaymentId = (await pool.query('SELECT provider_payment_id FROM payment_attempts WHERE payment_id=$1', [payment.paymentId])).rows[0].provider_payment_id;
    const pending = provider.getPayment.bind(provider);
    provider.getPayment = async id => { await new Promise(resolve => setTimeout(resolve, 10)); return pending(id); };
    await Promise.all([
      payments.webhook({ providerPaymentId, status: 'succeeded', resolution: 'known', amountMinor: 9900, currency: 'RUB' }),
      payments.reconcile(ctx, payment.paymentId),
    ]);
    const final = await payments.getPayment(ctx, { paymentId: payment.paymentId });
    assert.equal(final.status, 'succeeded');
    assert.equal(Number((await pool.query("SELECT count(*) AS n FROM payment_outbox WHERE aggregate_id=$1 AND type='payment.succeeded'", [payment.paymentId])).rows[0].n), 1);
  });
