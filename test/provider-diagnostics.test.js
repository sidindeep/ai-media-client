const test = require('node:test');
const assert = require('node:assert/strict');
const { recordFailure, providerFailure } = require('../src/provider-diagnostics');
const { publicRecord } = require('../src/services/accounts');
const systemErrors = require('../src/system-errors');
const { appendGenerationEvent } = require('../src/services/generation-journal');

test('Kie details reach the owner history and central diagnostic metadata', async () => {
  const record = { id: 'job-1', state: 'fail', modelId: 'seedream', error: 'Генерация завершилась ошибкой у провайдера.',
    errorInfo: { providerCode: '500', providerMessage: 'File type not supported' } };
  const shown = publicRecord(record);
  assert.match(shown.error, /500.*File type not supported/);
  assert.equal(recordFailure(record, 'Kie.ai').code, '500');
  const systemRows = [];
  const aiLogger = require('../src/ai-logger'), original = aiLogger.reportSystemError;
  aiLogger.reportSystemError = row => { systemRows.push(row); return true; };
  try {
    await appendGenerationEvent({ async query() { return { rows: [] }; } }, 'account-1', 'kie', record, 'fail', { error: record.error });
    await systemErrors.flush();
    assert.equal(systemRows.at(-1).code, '500');
    assert.equal(Object.hasOwn(systemRows.at(-1), 'message'), false);
  } finally { aiLogger.reportSystemError = original; }
});

test('Provider diagnostics retain structured codes and remove secrets', () => {
  const failure = providerFailure({ error: { code: 'INVALID_FILE', message: 'File type not supported; Bearer private-token' },
    prompt: 'private prompt' }, { provider: 'RouterAI', status: 422 });
  assert.match(failure.message, /422.*INVALID_FILE.*File type not supported/);
  assert.doesNotMatch(failure.message, /private-token|private prompt/);
});
