const test = require('node:test');
const assert = require('node:assert/strict');
const { calculate, quoteResult, evaluateQuote } = require('../src/billing/quote-engine');
const { normalizePricingInput } = require('../src/billing/normalize-request');
const { buildRequest } = require('../src/adapters');

test('shared strategies calculate request, output, bundle, duration and measured token prices', () => {
  assert.equal(calculate({ strategy: 'request', rate: 7 }), 7);
  assert.equal(calculate({ strategy: 'image', rate: 4.8, quantity: 4 }), 19.2);
  assert.equal(calculate({ strategy: 'imageBundle', rate: 6, quantity: 3, bundleSize: 2 }), 12);
  assert.equal(calculate({ strategy: 'second', rate: 3.5, quantity: 8 }), 28);
  assert.equal(calculate({ strategy: 'characterBundle', rate: 2, quantity: 1001, bundleSize: 1000 }), 4);
  assert.equal(calculate({ strategy: 'token', rate: 0.4, quantity: 2500, bundleSize: 1000 }), 1);
  assert.throws(() => calculate({ strategy: 'token', rate: 0.4 }), /фактический расход/);
});

test('Wan output count is identical in pricing input and provider request', () => {
  for (const apiModel of ['wan/2-7-image', 'wan/2-7-image-pro']) {
    const model = { apiModel };
    for (const [input, expected] of [[{}, 4], [{ enable_sequential: true }, 12], [{ n: 2 }, 2]]) {
      const normalized = normalizePricingInput(model, input);
      assert.equal(normalized.n, expected);
      assert.equal(buildRequest(model, normalized).input.n, expected);
      assert.notEqual(normalized, input);
      if (input.n === undefined) assert.equal(input.n, undefined);
    }
  }
});

test('unknown actual usage remains unavailable rather than zero', () => {
  assert.deepEqual(quoteResult('unavailable', { reason: 'actual_usage_unknown' }),
    { status: 'unavailable', reason: 'actual_usage_unknown' });
  const result = evaluateQuote(() => { throw new Error('unknown usage'); }, () => 'actual_usage_unknown');
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'actual_usage_unknown');
  assert.equal(evaluateQuote(() => ({ amount: 4 })).quote.amount, 4);
});
