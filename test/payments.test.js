const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { testPool } = require('./helpers/pg-pool');
const { openDatabase } = require('../src/database/database');
const { createPayments } = require('../src/payments/service');
const { createCommerce } = require('../src/commerce/service');
const { createProductCatalog } = require('../src/commerce/catalog');
const { createFakePaymentProvider } = require('./helpers/payment-provider');
const { createYooKassaProvider, amountValue, parseAmount } = require('../src/payments/providers/yookassa');
const { createYooKassaStubProvider } = require('../src/payments/providers/yookassa-stub');
const { createHttpServer } = require('../src/server/http');
const { loadConfig } = require('../src/server/config');

async function fixture() {
  const pool = await openDatabase({}, testPool());
  const accountId = randomUUID();
  await pool.query("INSERT INTO media_accounts(id,display_name) VALUES($1,'Buyer')", [accountId]);
  await pool.query('INSERT INTO media_wallets(account_id,balance) VALUES($1,0)', [accountId]);
  const catalog = { list: () => [{ id: 'credits-10', version: 'v1', name: '10 кредитов', description: '', creditUnits: 10000, amountMinor: 9900, currency: 'RUB', active: true }],
    get: (id, version) => { if (id !== 'credits-10' || version !== 'v1') throw new Error('Предложение недоступно'); return { id, version, name: '10 кредитов', description: '', creditUnits: 10000, amountMinor: 9900, currency: 'RUB', active: true }; } };
  let commerce;
  const payments = createPayments({ pool, provider: createFakePaymentProvider(), onEvent: event => commerce.handlePaymentEvent(event) });
  commerce = createCommerce({ pool, catalog, paymentClient: payments, paymentContext: { clientId: 'ai-media-client', environment: 'test' } });
  return { pool, accountId, payments, commerce };
}

test('payment contracts keep exact minor units and reject invalid transitions', () => {
  const { normalizeCreate, payloadHash, assertTransition } = require('../src/payments/contracts');
  const value = normalizeCreate({ externalOrderId: 'order-123', amountMinor: 9900, currency: 'rub', idempotencyKey: 'checkout-123', description: 'Пакет', returnUrl: 'https://example.test/return' });
  assert.equal(value.currency, 'RUB'); assert.equal(value.amountMinor, 9900);
  assert.equal(payloadHash({ b: 2, a: 1 }), payloadHash({ a: 1, b: 2 }));
  assert.throws(() => normalizeCreate({ ...value, amountMinor: 1.5 }), /amountMinor/);
  assert.throws(() => assertTransition('succeeded', 'canceled'), /нельзя отменить/);
});

test('order checkout fulfills credits once after durable payment event', async t => {
  const f = await fixture(); t.after(() => f.pool.end());
  const order = await f.commerce.createOrder(f.accountId, { offerId: 'credits-10', offerVersion: 'v1', idempotencyKey: 'checkout-first' });
  assert.equal((await f.commerce.createOrder(f.accountId, { offerId: 'credits-10', offerVersion: 'v1', idempotencyKey: 'checkout-first' })).id, order.id);
  const checked = await f.commerce.checkout(f.accountId, order.id, 'https://example.test/app');
  assert.equal(checked.status, 'fulfilled');
  assert.equal(Number((await f.pool.query('SELECT balance FROM media_wallets WHERE account_id=$1', [f.accountId])).rows[0].balance), 10000);
  assert.equal(Number((await f.pool.query("SELECT count(*) AS count FROM media_ledger WHERE account_id=$1 AND kind='purchase'", [f.accountId])).rows[0].count), 1);
  await f.payments.deliver();
  assert.equal(Number((await f.pool.query("SELECT count(*) AS count FROM media_ledger WHERE account_id=$1 AND kind='purchase'", [f.accountId])).rows[0].count), 1);
});

test('two outbox dispatchers claim one event once', async t => {
  const f = await fixture(); t.after(() => f.pool.end());
  const order = await f.commerce.createOrder(f.accountId, { offerId: 'credits-10', offerVersion: 'v1', idempotencyKey: 'concurrent-delivery' });
  await f.commerce.checkout(f.accountId, order.id, 'https://example.test/app');
  await f.pool.query('UPDATE payment_outbox SET delivered_at=NULL,attempts=0');
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let handled = 0;
  const onEvent = async () => { handled++; entered(); await gate; };
  const first = createPayments({ pool: f.pool, provider: createFakePaymentProvider(), onEvent });
  const second = createPayments({ pool: f.pool, provider: createFakePaymentProvider(), onEvent });
  const pending = first.deliver();
  await started;
  await second.deliver();
  assert.equal(handled, 1);
  release();
  await pending;
  const row = (await f.pool.query('SELECT delivered_at,attempts,lease_token FROM payment_outbox')).rows[0];
  assert.ok(row.delivered_at);
  assert.equal(row.attempts, 1);
  assert.equal(row.lease_token, null);
});

test('payment webhook resolves pending checkout and grants credits once', async t => {
  const pool = await openDatabase({}, testPool());
  t.after(() => pool.end());
  const accountId = randomUUID();
  await pool.query("INSERT INTO media_accounts(id,display_name) VALUES($1,'Webhook buyer')", [accountId]);
  await pool.query('INSERT INTO media_wallets(account_id,balance) VALUES($1,0)', [accountId]);
  const catalog = { get: () => ({ id: 'credits-10', version: 'v1', name: '10 кредитов', description: '', creditUnits: 10000, amountMinor: 9900, currency: 'RUB', active: true }) };
  let commerce;
  const payments = createPayments({ pool, provider: createFakePaymentProvider({ behavior: 'pending' }), onEvent: event => commerce.handlePaymentEvent(event) });
  commerce = createCommerce({ pool, catalog, paymentClient: payments, paymentContext: { clientId: 'ai-media-client', environment: 'test' } });
  const order = await commerce.createOrder(accountId, { offerId: 'credits-10', offerVersion: 'v1', idempotencyKey: 'webhook-first' });
  const checkout = await commerce.checkout(accountId, order.id, 'https://example.test/app');
  const attempt = (await pool.query('SELECT provider_payment_id FROM payment_attempts WHERE payment_id=$1', [checkout.paymentId])).rows[0];
  const event = { providerPaymentId: attempt.provider_payment_id, status: 'succeeded', resolution: 'known', amountMinor: 9900, currency: 'RUB' };
  await payments.webhook(event);
  await payments.webhook(event);
  assert.equal(Number((await pool.query('SELECT balance FROM media_wallets WHERE account_id=$1', [accountId])).rows[0].balance), 10000);
  assert.equal(Number((await pool.query("SELECT count(*) AS count FROM media_ledger WHERE account_id=$1 AND kind='purchase'", [accountId])).rows[0].count), 1);
});

test('verified early webhook is processed after provider payment ID is stored', async t => {
  const pool = await openDatabase({}, testPool());
  t.after(() => pool.end());
  const accountId = randomUUID();
  await pool.query("INSERT INTO media_accounts(id,display_name) VALUES($1,'Early webhook')", [accountId]);
  await pool.query('INSERT INTO media_wallets(account_id,balance) VALUES($1,0)', [accountId]);
  const catalog = { get: () => ({ id: 'credits-10', version: 'v1', name: '10 кредитов', description: '', creditUnits: 10000, amountMinor: 9900, currency: 'RUB', active: true }) };
  const provider = createFakePaymentProvider({ behavior: 'pending' });
  const originalCreate = provider.createPayment.bind(provider);
  let payments, commerce;
  provider.createPayment = async request => {
    const pending = await originalCreate(request);
    await payments.webhook({ ...pending, status: 'succeeded' });
    return pending;
  };
  payments = createPayments({ pool, provider, onEvent: event => commerce.handlePaymentEvent(event) });
  commerce = createCommerce({ pool, catalog, paymentClient: payments, paymentContext: { clientId: 'ai-media-client', environment: 'test' } });
  const order = await commerce.createOrder(accountId, { offerId: 'credits-10', offerVersion: 'v1', idempotencyKey: 'early-webhook' });
  await commerce.checkout(accountId, order.id, 'https://example.test/app');
  assert.equal((await commerce.getOrder(accountId, order.id)).status, 'fulfilled');
  assert.equal(Number((await pool.query('SELECT balance FROM media_wallets WHERE account_id=$1', [accountId])).rows[0].balance), 10000);
  assert.ok((await pool.query('SELECT processed_at FROM payment_webhook_inbox')).rows[0].processed_at);
});

test('uncertain create recovers with its saved request and original provider key', async t => {
  const pool = await openDatabase({}, testPool());
  t.after(() => pool.end());
  const provider = createFakePaymentProvider({ behavior: 'timeout-after-accept' });
  const payments = createPayments({ pool, provider });
  const ctx = { clientId: 'recovery-test', environment: 'test' };
  const input = { externalOrderId: randomUUID(), amountMinor: 9900, currency: 'RUB',
    idempotencyKey: randomUUID(), description: 'Recovery test', returnUrl: 'https://example.test/return' };
  await assert.rejects(payments.createPayment(ctx, input), error => error.code === 'OPERATION_UNCERTAIN');
  const command = (await pool.query('SELECT request_payload,idempotency_key FROM payment_commands')).rows[0];
  assert.equal(command.idempotency_key, input.idempotencyKey);
  assert.equal(command.request_payload.externalOrderId, input.externalOrderId);
  await pool.query("UPDATE payment_commands SET created_at=now()-interval '31 seconds'");
  await payments.recoverCommands();
  const payment = await payments.getPaymentByOrder(ctx, { externalOrderId: input.externalOrderId });
  assert.equal(payment.status, 'succeeded');
  await payments.recoverCommands();
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM payment_outbox')).rows[0].n), 1);
});

test('payment idempotency is scoped and conflicting payload is rejected', async t => {
  const f = await fixture(); t.after(() => f.pool.end());
  const ctx = { clientId: 'second-product', environment: 'test' };
  const input = { externalOrderId: 'order-other', amountMinor: 100, currency: 'RUB', idempotencyKey: 'same-key-123', description: 'Test', returnUrl: 'https://example.test' };
  const first = await f.payments.createPayment(ctx, input);
  assert.equal((await f.payments.createPayment(ctx, input)).paymentId, first.paymentId);
  await assert.rejects(f.payments.createPayment(ctx, { ...input, amountMinor: 200 }), error => error.code === 'IDEMPOTENCY_CONFLICT');
});

test('YooKassa adapter uses Basic auth, exact RUB string and verifies test environment', async () => {
  assert.equal(amountValue(9900), '99.00');
  assert.equal(parseAmount('99.00'), 9900);
  assert.throws(() => parseAmount('99.0'));
  let request;
  const provider = createYooKassaProvider({ shopId: 'shop', secretKey: 'secret', fetcher: async (url, options) => {
    request = { url, options }; return { ok: true, async json() { return { id: 'provider-1', status: 'pending', test: true, amount: { value: '99.00', currency: 'RUB' }, confirmation: { confirmation_url: 'https://yookassa.test/pay' } }; } };
  } });
  assert.equal(provider.capabilities().refunds, false);
  const result = await provider.createPayment({ clientId: 'ai-media-client', externalOrderId: 'order-1', amountMinor: 9900, currency: 'RUB', idempotencyKey: 'idem-12345678', description: 'Пакет', returnUrl: 'https://example.test/app' });
  assert.equal(result.confirmationUrl, 'https://yookassa.test/pay');
  assert.match(request.options.headers.Authorization, /^Basic /);
  assert.equal(JSON.parse(request.options.body).capture, true);
  assert.equal(JSON.parse(request.options.body).amount.value, '99.00');
});

test('published product catalog exposes the approved credit packages', () => {
  const offers = createProductCatalog(path.resolve(__dirname, '../config/product-offers.json')).list();
  const { SCALE } = require('../src/billing/pricing');
  assert.deepEqual(offers.map(({ name, creditUnits, amountMinor, currency }) => ({ name, credits: creditUnits / SCALE, amountMinor, currency })), [
    { name: 'Старт', credits: 450, amountMinor: 49000, currency: 'RUB' },
    { name: 'Базовый', credits: 1000, amountMinor: 99000, currency: 'RUB' },
    { name: 'Pro', credits: 2200, amountMinor: 199000, currency: 'RUB' },
    { name: 'Business', credits: 6000, amountMinor: 499000, currency: 'RUB' },
    { name: 'Agency', credits: 13000, amountMinor: 999000, currency: 'RUB' },
  ]);
});

test('offer card HTTP checkout reaches the YooKassa stub without charging or granting credits', async t => {
  const pool = await openDatabase({}, testPool());
  const accountId = randomUUID();
  await pool.query("INSERT INTO media_accounts(id,display_name) VALUES($1,'Buyer')", [accountId]);
  await pool.query('INSERT INTO media_wallets(account_id,balance) VALUES($1,0)', [accountId]);
  const config = loadConfig({ MEDIA_PORT: '0', MEDIA_PAYMENTS_ENABLED: 'true', MEDIA_SALES_ENABLED: 'true', MEDIA_PAYMENTS_PROVIDER: 'yookassa-stub' });
  const provider = createYooKassaStubProvider();
  let commerce;
  const payments = createPayments({ pool, provider, onEvent: event => commerce.handlePaymentEvent(event) });
  commerce = createCommerce({ pool, catalog: createProductCatalog(config.commerce.offersFile), paymentClient: payments,
    paymentContext: { clientId: config.payments.clientId, environment: config.payments.environment } });
  const server = createHttpServer({ config, service: {}, accounts: { pool }, auth: { user: async () => ({ id: accountId, role: 'user' }), providers: () => [] }, payments, commerce });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeIdleConnections(); await new Promise(resolve => server.close(resolve)); await pool.end(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async route => { const response = await fetch(base + route); assert.equal(response.status, 200); return (await response.json()).result; };
  const post = async (route, body = {}) => {
    const response = await fetch(base + route, { method: 'POST', headers: { 'X-Media-Client': 'web', 'X-Media-User': accountId, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    return payload.result;
  };
  const offers = await get('/api/commerce/offers');
  assert.equal(offers.length, 5);
  assert.equal(offers[0].checkoutMode, 'stub');
  const offer = offers[0];
  const order = await post('/api/commerce/orders', { offerId: offer.id, offerVersion: offer.version, idempotencyKey: 'card-stub-checkout' });
  const checked = await post(`/api/commerce/orders/${order.id}/checkout`);
  assert.equal(checked.status, 'awaiting_payment');
  assert.equal(checked.checkoutMode, 'stub');
  assert.equal(checked.confirmationUrl, null);
  assert.ok(checked.paymentId);
  assert.equal((await post(`/api/commerce/orders/${order.id}/checkout`)).paymentId, checked.paymentId);
  assert.equal((await get(`/api/commerce/orders/${order.id}`)).paymentId, checked.paymentId);
  assert.equal((await get('/api/commerce/orders'))[0].checkoutMode, 'stub');
  assert.equal((await pool.query('SELECT provider_id,state FROM payment_attempts WHERE payment_id=$1', [checked.paymentId])).rows[0].provider_id, 'yookassa-stub');
  assert.equal(Number((await pool.query('SELECT balance FROM media_wallets WHERE account_id=$1', [accountId])).rows[0].balance), 0);
  assert.equal(Number((await pool.query('SELECT count(*) AS count FROM media_order_fulfillments WHERE order_id=$1', [order.id])).rows[0].count), 0);
});

test('YooKassa stub cannot be selected for live payments', () => {
  assert.throws(() => loadConfig({ MEDIA_PAYMENTS_PROVIDER: 'yookassa-stub', MEDIA_PAYMENTS_ENVIRONMENT: 'live' }), /только в test/);
});

test('test sales without YooKassa keys select the no-charge stub', () => {
  const config = loadConfig({ MEDIA_PAYMENTS_ENABLED: 'true', MEDIA_SALES_ENABLED: 'true', MEDIA_PAYMENTS_ENVIRONMENT: 'test', MEDIA_PAYMENTS_PROVIDER: 'yookassa' });
  assert.equal(config.payments.provider, 'yookassa-stub');
  assert.equal(loadConfig({ MEDIA_PAYMENTS_ENVIRONMENT: 'live', MEDIA_PAYMENTS_PROVIDER: 'yookassa' }).payments.provider, 'yookassa');
  assert.equal(loadConfig({ MEDIA_PAYMENTS_ENVIRONMENT: 'test', MEDIA_PAYMENTS_PROVIDER: 'yookassa', YOOKASSA_SHOP_ID: 'shop', YOOKASSA_SECRET_KEY: 'key' }).payments.provider, 'yookassa');
});

test('payment bounded context does not import product modules or query product tables', async () => {
  const fs = require('node:fs/promises');
  const files = ['contracts.js', 'service.js', 'providers/yookassa.js'];
  for (const file of files) {
    const source = await fs.readFile(path.resolve(__dirname, '../src/payments', file), 'utf8');
    assert.doesNotMatch(source, /require\(['"]\.\.\/commerce|media_(accounts|wallets|orders|ledger)/);
  }
});
