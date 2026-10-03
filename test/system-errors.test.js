const test = require('node:test');
const assert = require('node:assert/strict');
const aiLogger = require('../src/ai-logger');
const errors = require('../src/system-errors');
const trace = require('../src/generation-log');

test('successful system events use INFO and textual errors retain safe descriptions', () => {
  const originalEvent = aiLogger.reportEvent, originalError = aiLogger.reportSystemError;
  const events = [], errorsReported = [];
  aiLogger.reportEvent = (...args) => events.push(args);
  aiLogger.reportSystemError = row => errorsReported.push(row);
  try {
    errors.info('studio', 'chat.history.loaded', 'private', { accountId: 'private' });
    assert.deepEqual(events, [['studio', 'chat.history.loaded', 'INFO']]);
    errors.record('server', 'console.error', 'Connection failed');
    assert.equal(errorsReported[0].diagnostic.description, 'Connection failed');
    assert.equal(errorsReported[0].diagnostic.file, undefined);
  } finally { aiLogger.reportEvent = originalEvent; aiLogger.reportSystemError = originalError; }
});

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

test('network diagnostics preserve bounded nested causes without secrets or arbitrary payloads', () => {
  const { diagnostic, sanitizer } = require('../src/ai-logger/diagnostics');
  sanitizer.secret('private-cause-fixture');
  const socket = Object.assign(new Error('Connection reset private-cause-fixture; token=private-token-fixture'),
    { code: 'ECONNRESET', request: 'DO_NOT_SEND_REQUEST' });
  const timeout = Object.assign(new Error('Connection timed out'), { code: 'ETIMEDOUT' });
  const nested = new AggregateError([socket, timeout], 'All connections failed');
  const failure = new TypeError('fetch failed', { cause: nested });
  socket.cause = failure;
  const stack = failure.stack;
  const row = diagnostic('provider', 'apimart.connection.error', failure,
    { description: 'Не удалось подключиться к APIMart' });
  assert.match(row.description, /^Не удалось подключиться к APIMart; cause:/);
  assert.match(row.description, /ECONNRESET/);
  assert.match(row.description, /ETIMEDOUT/);
  for (const privateText of ['private-cause-fixture', 'private-token-fixture', 'DO_NOT_SEND_REQUEST'])
    assert.ok(!JSON.stringify(row).includes(privateText));
  assert.ok(row.description.length <= 1000);
  assert.equal(failure.stack, stack);
});
