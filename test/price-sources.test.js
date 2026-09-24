const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolvePriceSources } = require('../src/billing/price-sources');

test('price sources prefer a verified account quote and do not contact lower priorities', async () => {
  const called = [];
  const result = await resolvePriceSources([
    { id: 'account', quote: async () => { called.push('account'); return { amountUnits: 30000, version: 'account-1' }; } },
    { id: 'public', quote: () => { called.push('public'); throw new Error('should not run'); } },
  ]);
  assert.equal(result.source, 'account');
  assert.equal(result.quote.amountUnits, 30000);
  assert.deepEqual(called, ['account']);
});

test('price sources reject invalid and failed quotes before using a documented rate', async () => {
  const result = await resolvePriceSources([
    { id: 'account', quote: async () => ({ amountUnits: 0, version: 'bad' }) },
    { id: 'public', quote: () => { throw new Error('offline'); } },
    { id: 'documented', quote: () => ({ amountUnits: 22500, version: 'page-2026-09-22' }) },
  ]);
  assert.equal(result.source, 'documented');
  assert.equal(result.quote.amountUnits, 22500);
  assert.deepEqual(result.attempts.map(item => item.source), ['account', 'public']);
  assert.deepEqual(result.attempts.map(item => item.status), ['unavailable', 'unavailable']);
});

test('price sources leave unknown prices unknown', async () => {
  const result = await resolvePriceSources([{ id: 'public', quote: () => null }]);
  assert.equal(result.source, null);
  assert.equal(result.quote, null);
});

test('price sources continue when provider conversion rejects an otherwise positive quote', async () => {
  const result = await resolvePriceSources([
    { id: 'account', quote: () => ({ amountUnits: 1, version: 'account' }) },
    { id: 'public', quote: () => ({ amountUnits: 30000, version: 'public' }) },
  ], raw => {
    if (raw.amountUnits < 1000) throw new Error('invalid conversion');
    return { credits: raw.amountUnits / 1000 };
  });
  assert.equal(result.source, 'public');
  assert.deepEqual(result.value, { credits: 30 });
});
