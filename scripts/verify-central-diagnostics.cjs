const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const logger = require('../src/ai-logger');
const errors = require('../src/system-errors');
const { generationContext } = require('../src/ai-logger/generation-context.mjs');
async function main() {
  const { project, instanceId } = require('../src/ai-logger/identity').resolveIdentity();
  const marker = 'diagnostic-check-' + randomUUID();
  function safeDiagnosticFailure() {
    const cause = Object.assign(new Error('Connection reset; token=DO_NOT_SEND_CAUSE_TOKEN'), { code: 'ECONNRESET' });
    throw Object.assign(new Error('Safe diagnostic test ' + marker, { cause }), { code: 'DIAGNOSTIC_TEST' });
  }
  let failure;
  try { safeDiagnosticFailure(); } catch (error) { failure = error; }
  const originalStack = failure.stack;
  const assetId = randomUUID();
  const generation = generationContext({ id: marker, modelId: 'diagnostic-fixture',
    input: { prompt: 'Тестовый промпт: кот на синем фоне ' + marker, image_input: ['content:' + assetId] } }, 'kie');
  errors.record('diagnostic-test', 'integration.error', failure,
    { diagnostic: { description: 'Безопасная проверка диагностики ' + marker, entity: 'diagnostic-test' },
      prompt: 'DO_NOT_SEND_PROMPT', cookies: 'DO_NOT_SEND_COOKIE', accountId: 'DO_NOT_SEND_ACCOUNT' });
  // Capture on a private console surface to avoid altering the running service.
  const target = { error() {} };
  const restoreConsole = errors.captureConsole(target);
  try {
    target.error('Console diagnostic ' + marker, failure, { prompt: 'DO_NOT_SEND_CONSOLE_PAYLOAD' });
    target.error('String diagnostic ' + marker, 'token=DO_NOT_SEND_CONSOLE_TOKEN');
  } finally { restoreConsole(); }
  errors.record('generation', 'integration.generation.error', { code: '1501', message: 'Content review failed' },
    { generation, diagnostic: { description: 'Generation context check ' + marker } });
  logger.reportGenerationEvent('generation.started', 'kie', { id: assetId, state: 'submitting', prompt: 'DO_NOT_SEND_SUCCESS_PROMPT' });
  for (const event of ['generation.account_service', 'task.poll.start', 'task.poll.success', 'http.request', 'http.response'])
    assert.equal(logger.reportEvent('diagnostic', event), false);
  assert.equal(logger.reportEvent('studio', 'chat.sync.loaded'), false);
  assert.equal(logger.reportEvent('startup', 'runtime.ready'), false);
  logger.reportGenerationEvent('generation.completed', 'kie', { id: assetId, state: 'success' });
  await logger.flush();
  assert.equal(failure.stack, originalStack);
  const url = new URL(process.env.AI_LOGGER_READ_URL || '/api/agent/logs', process.env.AI_LOGGER_SERVER_URL);
  url.searchParams.set('project', project); url.searchParams.set('limit', '200');
  const headers = process.env.AI_LOGGER_READ_TOKEN ? { Authorization: 'Bearer ' + process.env.AI_LOGGER_READ_TOKEN } : {};
  let saved, consoleSaved, stringSaved, generationSaved, lifecycleRows = [];
  for (let attempt = 0; attempt < 30 && !(saved && consoleSaved && stringSaved && generationSaved && lifecycleRows.length === 2); attempt++) {
    // Startup traffic and bounded drains can defer later records to retry.
    await logger.flush();
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
    assert.ok(response.ok, 'Logger reader HTTP ' + response.status);
    const data = await response.json();
    saved = data.records?.find(row => row.message === 'integration.error' && row.context?.description?.includes(marker));
    consoleSaved = data.records?.find(row => row.context?.description?.startsWith('Console diagnostic ' + marker + '; cause:'));
    stringSaved = data.records?.find(row => row.context?.description?.startsWith('String diagnostic ' + marker));
    generationSaved = data.records?.find(row => row.message === 'integration.generation.error' && row.context?.description?.includes(marker));
    lifecycleRows = data.records?.filter(row => row.context?.instance_id === instanceId && row.level === 'INFO') || [];
    if (!(saved && consoleSaved && stringSaved && generationSaved && lifecycleRows.length === 2)) await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.ok(saved, 'Test error was not read back from /api/agent/logs: ' + marker);
  assert.equal(saved.message, 'integration.error');
  assert.equal(saved.context.error_code, 'DIAGNOSTIC_TEST');
  assert.ok(saved.context.description.startsWith('Безопасная проверка диагностики ' + marker + '; cause:'));
  assert.match(saved.context.description, /ECONNRESET/);
  assert.equal(saved.context.entity, 'diagnostic-test');
  assert.equal(saved.context.project, project);
  assert.equal(saved.context.instance_id, instanceId);
  assert.equal(saved.context.service, process.env.AI_LOGGER_SERVICE || process.env.MEDIA_REPLICA_ROLE || 'web');
  assert.equal(saved.exception.type, 'Error');
  assert.equal(saved.exception.message, failure.message);
  assert.equal(saved.exception.stack_trace, originalStack.slice(0, 4000));
  assert.ok(saved.context.file.endsWith('scripts/verify-central-diagnostics.cjs'));
  assert.ok(Number(saved.context.line) > 0);
  assert.equal(saved.context.function, 'safeDiagnosticFailure');
  assert.ok(!JSON.stringify(saved).includes('DO_NOT_SEND_'));
  assert.ok(consoleSaved && stringSaved, 'Console diagnostics were not read back');
  assert.equal(consoleSaved.message, 'console.error');
  assert.equal(consoleSaved.context.error_code, 'DIAGNOSTIC_TEST');
  assert.equal(consoleSaved.exception.stack_trace, originalStack.slice(0, 4000));
  assert.equal(consoleSaved.context.instance_id, instanceId);
  assert.equal(consoleSaved.context.function, 'safeDiagnosticFailure');
  assert.equal(stringSaved.message, 'console.error');
  assert.ok(!stringSaved.exception);
  assert.equal(stringSaved.context.file, undefined);
  assert.ok(!JSON.stringify([consoleSaved, stringSaved]).includes('DO_NOT_SEND_'));
  assert.ok(generationSaved, 'Generation context was not read back: ' + marker);
  assert.equal(generationSaved.context.prompt, generation.prompt);
  assert.deepEqual(generationSaved.context.source_urls, generation.source_urls);
  assert.equal(generationSaved.context.model, generation.model);
  assert.equal(generationSaved.context.provider, 'kie');
  assert.equal(generationSaved.context.job_id, marker);
  assert.equal(generationSaved.context.error_code, '1501');
  assert.deepEqual(lifecycleRows.map(row => row.message).sort(), ['generation.completed', 'generation.started']);
  assert.ok(lifecycleRows.every(row => row.context.job_id === assetId && row.context.provider === 'kie'));
  assert.ok(!JSON.stringify(lifecycleRows).includes('DO_NOT_SEND_'));
  console.log(JSON.stringify({ marker, delivered: true, instance_id: saved.context.instance_id,
    service: saved.context.service, file: saved.context.file, line: saved.context.line,
    function: saved.context.function, entity: saved.context.entity, description: saved.context.description,
    exception_verified: true, cause_verified: true, console_verified: true, string_diagnostic_verified: true,
    sensitive_data_excluded: true, generation_context_verified: true,
    lifecycle_verified: true, noise_filtered: true }, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => logger.close());
