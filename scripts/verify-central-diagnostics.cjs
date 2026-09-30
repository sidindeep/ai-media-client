const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const logger = require('../src/ai-logger');
const errors = require('../src/system-errors');
async function main() {
  assert.ok(process.env.AI_LOGGER_INSTANCE_ID, 'Permanent machine ID is required');
  const marker = 'diagnostic-check-' + randomUUID();
  function safeDiagnosticFailure() { throw Object.assign(new Error('Safe diagnostic test ' + marker), { code: 'DIAGNOSTIC_TEST' }); }
  let failure;
  try { safeDiagnosticFailure(); } catch (error) { failure = error; }
  const originalStack = failure.stack;
  errors.record('diagnostic-test', 'integration.error', failure,
    { diagnostic: { description: 'Безопасная проверка диагностики ' + marker, entity: 'diagnostic-test' },
      prompt: 'DO_NOT_SEND_PROMPT', cookies: 'DO_NOT_SEND_COOKIE', accountId: 'DO_NOT_SEND_ACCOUNT' });
  await logger.flush();
  assert.equal(failure.stack, originalStack);
  const url = new URL(process.env.AI_LOGGER_READ_URL || '/api/agent/logs', process.env.AI_LOGGER_SERVER_URL);
  url.searchParams.set('project', process.env.AI_LOGGER_PROJECT); url.searchParams.set('limit', '200');
  const headers = process.env.AI_LOGGER_READ_TOKEN ? { Authorization: 'Bearer ' + process.env.AI_LOGGER_READ_TOKEN } : {};
  let saved;
  for (let attempt = 0; attempt < 10 && !saved; attempt++) {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
    assert.ok(response.ok, 'Logger reader HTTP ' + response.status);
    const data = await response.json();
    saved = data.records?.find(row => row.context?.description?.includes(marker));
    if (!saved) await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.ok(saved, 'Test error was not read back from /api/agent/logs: ' + marker);
  assert.equal(saved.message, 'integration.error');
  assert.equal(saved.context.error_code, 'DIAGNOSTIC_TEST');
  assert.equal(saved.context.description, 'Безопасная проверка диагностики ' + marker);
  assert.equal(saved.context.entity, 'diagnostic-test');
  assert.equal(saved.context.instance_id, process.env.AI_LOGGER_INSTANCE_ID);
  assert.equal(saved.context.service, process.env.AI_LOGGER_SERVICE || process.env.MEDIA_REPLICA_ROLE || 'web');
  assert.equal(saved.exception.type, 'Error');
  assert.equal(saved.exception.message, failure.message);
  assert.equal(saved.exception.stack_trace, originalStack.slice(0, 4000));
  assert.ok(saved.context.file.endsWith('scripts/verify-central-diagnostics.cjs'));
  assert.ok(Number(saved.context.line) > 0);
  assert.equal(saved.context.function, 'safeDiagnosticFailure');
  assert.ok(!JSON.stringify(saved).includes('DO_NOT_SEND_'));
  console.log(JSON.stringify({ marker, delivered: true, instance_id: saved.context.instance_id,
    service: saved.context.service, file: saved.context.file, line: saved.context.line,
    function: saved.context.function, entity: saved.context.entity, description: saved.context.description,
    exception_verified: true, sensitive_data_excluded: true }, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => logger.close());
