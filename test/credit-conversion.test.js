const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCreditConversion } = require('../src/billing/conversion');

const policy = { version: 'test-policy', deductionsFraction: 0.105, costMarkupFraction: 0.01 };
const offers = [
  { active: true, currency: 'RUB', amountMinor: 99000, creditUnits: 1000000 },
  { active: true, currency: 'RUB', amountMinor: 999000, creditUnits: 13000000 },
];

test('cost floor protects the cheapest credit package after deductions', () => {
  const conversion = createCreditConversion({ offers, policy, kieRubPerCredit: 0.51 });
  const quote = conversion.quote('routerai', { amount: 10, currency: 'RUB', version: 'provider-v1' });
  const cheapestRubPerCredit = 9990 / 13000;
  assert.equal(quote.amountUnits, Math.ceil(10 * 1.01 / (cheapestRubPerCredit * 0.895) * 1000 - 1e-9));
  assert.ok(quote.credits * cheapestRubPerCredit * 0.895 >= 10 * 1.01);
  assert.match(quote.version, /provider-v1.*test-policy/);
});

test('Kie native tariff remains a nominal price floor and Codex stays fixed', () => {
  const conversion = createCreditConversion({ offers, policy, kieRubPerCredit: 0.51 });
  assert.equal(conversion.quote('kie', { amountUnits: 5000, version: 'kie-v1' }).amountUnits, 5000);
  assert.equal(conversion.quote('codex', { amountUnits: 4000, version: 'codex-v1' }).amountUnits, 4000);
  assert.throws(() => conversion.quote('new-router', { amount: 1, currency: 'RUB' }), /не подключён/);
});

test('new currency adapters require an explicit current rate', () => {
  const options = { offers, policy, now: () => Date.parse('2026-09-23T00:00:00Z'),
    providerAdapters: { foreign: raw => ({ costAmount: raw.amount, costCurrency: raw.currency, rawVersion: raw.version }) } };
  const raw = { amount: 1, currency: 'USD', version: 'foreign-v1' };
  assert.throws(() => createCreditConversion(options).quote('foreign', raw), /Курс валюты/);
  const conversion = createCreditConversion({ ...options, fxRates: { USD: { rubPerUnit: 80, version: 'fx-v1', validUntil: '2026-09-24T00:00:00Z' } } });
  const quote = conversion.quote('foreign', raw);
  assert.ok(quote.credits > 80);
  assert.match(quote.version, /fx-v1/);
  assert.throws(() => createCreditConversion({ ...options, now: () => Date.parse('2026-09-25T00:00:00Z'),
    fxRates: { USD: { rubPerUnit: 80, version: 'fx-v1', validUntil: '2026-09-24T00:00:00Z' } } }).quote('foreign', raw), /устарел/);
});

test('admin snapshot reports the same active policy and example quotes', () => {
  const conversion = createCreditConversion({ offers, policy, kieRubPerCredit: 0.51 });
  const snapshot = conversion.snapshot();
  assert.equal(snapshot.version, 'test-policy');
  assert.equal(snapshot.offers.length, 2);
  assert.equal(snapshot.minimumRubPerCredit, 9990 / 13000);
  assert.equal(snapshot.providers.find(row => row.id === 'routerai').exampleCredits,
    conversion.quote('routerai', { amount: 1, currency: 'RUB', version: 'example' }).credits);
  assert.equal(snapshot.providers.find(row => row.id === 'codex').mode, 'fixed-product-price');
  assert.deepEqual(snapshot.fxRates, []);
});
