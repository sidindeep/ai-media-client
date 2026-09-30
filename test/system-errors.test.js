const test = require('node:test');
const assert = require('node:assert/strict');
const aiLogger = require('../src/ai-logger');
const errors = require('../src/system-errors');
const trace = require('../src/generation-log');

test('system errors use only central metadata, including registered-secret redaction', async () => {
  const rows = [], original = aiLogger.reportSystemError;
  aiLogger.reportSystemError = row => { rows.push(row); return true; };
  try {
    trace.secret('private-test-token');
    assert.equal(errors.record('server', 'example.error', Object.assign(new Error('Bearer private-test-token'), { code: 'TEST' }), { password: 'private-test-token' }), true);
    await errors.flush();
    assert.equal(rows[0].code, 'TEST');
    assert.ok(rows[0].error instanceof Error);
    assert.equal(rows[0].diagnostic.entity, 'server');
    assert.ok(!JSON.stringify(rows[0].diagnostic).includes('private-test-token')); // Original Error stays intact until the recorder sanitizes it.
    assert.equal(errors.setPool, undefined);
  } finally { aiLogger.reportSystemError = original; }
});

test('startup steps report failures before rethrowing the original error', async () => {
  const rows = [], events = [], original = aiLogger.reportSystemError, originalEvent = aiLogger.reportEvent;
  aiLogger.reportSystemError = row => { rows.push(row); return true; };
  aiLogger.reportEvent = (source, event) => events.push({ source, event });
  const failure = Object.assign(new Error('private connection string'), { code: 'ECONNREFUSED' });
  try {
    await assert.rejects(errors.step('startup', 'database', async () => { throw failure; }), error => error === failure);
    assert.deepEqual(events, [{ source: 'startup', event: 'database.start' }]);
    assert.equal(rows[0].error, failure);
    assert.equal(rows[0].code, 'ECONNREFUSED');
  } finally { aiLogger.reportSystemError = original; aiLogger.reportEvent = originalEvent; }
});

test('failed logger never turns a successful business action into an error', async () => {
  const original = aiLogger.reportSystemError;
  aiLogger.reportSystemError = () => { throw new Error('logger offline'); };
  try { assert.equal(errors.record('server', 'example.error', new Error('failure')), false); }
  finally { aiLogger.reportSystemError = original; }
});
