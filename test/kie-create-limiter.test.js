const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createKieCreateLimiter } = require('../src/services/kie-create-limiter');

test('Kie creation limiter admits a burst then waits for the rolling window', async () => {
  const limiter = createKieCreateLimiter({ limit: 2, windowMs: 40 });
  await Promise.all([limiter.wait(), limiter.wait()]);
  let admitted = false;
  const third = limiter.wait().then(() => { admitted = true; });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(admitted, false);
  await third;
  assert.equal(admitted, true);
});

test('confirmed 429 pauses all pending submissions on that credential', async () => {
  const limiter = createKieCreateLimiter({ limit: 2, windowMs: 40 });
  limiter.rateLimited();
  let admitted = false;
  const request = limiter.wait().then(() => { admitted = true; });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(admitted, false);
  await request;
  assert.equal(admitted, true);
});
