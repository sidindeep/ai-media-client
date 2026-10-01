const test = require('node:test');
const assert = require('node:assert/strict');
const { providerError, safeErrorText, execError, imageGenerationError } = require('../src/services/codex-errors');
const { parseCodexOutput } = require('../src/services/codex-usage');

test('Image failure preserves explicit error and excludes request and binary payloads', () => {
  const error = imageGenerationError({ status: 'failed', error: { code: 'content_policy_violation', message: 'Blocked', prompt: 'PRIVATE' },
    prompt: 'PRIVATE', result: 'a'.repeat(1000) });
  assert.match(error.message, /правилам безопасности.*content_policy_violation/);
  assert.doesNotMatch(error.message, /PRIVATE|aaaa|binary data/);
  assert.match(imageGenerationError({ status: 'failed', result: '' }).message, /не передал подробную причину/);
  assert.match(execError(JSON.stringify({ type: 'item.completed', item: { type: 'image_generation', status: 'failed', result: '' } })).message, /не передал подробную причину/);
});

test('Provider errors retain moderation and structured transport details, not request fields', () => {
  const error = providerError(JSON.stringify({ error: { code: 'moderation_blocked', message: 'Rejected by safety system.',
    moderation_details: { moderation_stage: 'output', categories: ['sexual'] } }, prompt: 'PRIVATE PROMPT' }));
  assert.match(error.message, /moderation_blocked/);
  assert.match(error.message, /Rejected by safety system/);
  assert.match(error.message, /output.*sexual/);
  assert.doesNotMatch(error.message, /PRIVATE PROMPT/);
  assert.match(providerError({ message: 'Overloaded', codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } } }).message, /429/);
});

test('Public error text removes credentials and binary data and stays bounded', () => {
  const text = safeErrorText('Bearer secret-bearer api_key="secret-key" cookie=secret-cookie sk-secretvalue https://example.test/a?token=secret-url '
    + 'data:image/png;base64,' + 'A'.repeat(400) + ' ' + 'x'.repeat(4000));
  for (const value of ['secret-bearer', 'secret-key', 'secret-cookie', 'sk-secretvalue', 'secret-url', 'A'.repeat(100)]) assert.ok(!text.includes(value));
  assert.ok(text.length <= 3000);
});

test('Exec JSONL failures retain provider codes and messages', () => {
  const output = JSON.stringify({ type: 'turn.failed', error: { message: 'Model unavailable', code: 'model_not_found' } });
  assert.match(execError(output).message, /model_not_found.*Model unavailable/);
  assert.throws(() => parseCodexOutput(output), /model_not_found/);
});

test('The result view displays Codex details for a non-admin owner', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const ts = require('typescript');
  const source = fs.readFileSync(path.join(__dirname, '../web/src/domain/result-presentation.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const context = { exports: {}, require: () => ({ t: key => key }) };
  vm.runInNewContext(compiled, context);
  const record = { providerId: 'codex', state: 'fail', error: 'Codex: moderation_blocked: Rejected by safety system.' };
  assert.equal(context.exports.resultError(record, false), record.error);
  assert.equal(context.exports.resultError({ ...record, providerId: 'media' }, false), record.error);
  for (const admin of [true, false]) {
    assert.equal(context.exports.resultError({ ...record, error: 'Codex image generation failed.' }, admin), 'error.codexImageReasonMissing');
    assert.equal(context.exports.resultError(record, admin), record.error);
  }
});
