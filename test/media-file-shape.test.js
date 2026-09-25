const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../web/src/domain/media-fields.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const moduleExports = {};
vm.runInNewContext(compiled, { exports: moduleExports, require: () => ({ t: key => key }) });
const { mediaFileValue, normalizeMediaInput } = moduleExports;

test('file wire shape follows the schema even when only one file is allowed', () => {
  const arrayField = { key: 'input_urls', type: 'files', scalar: false, maxFiles: 1, schema: { type: 'array' } };
  const scalarField = { key: 'image_url', type: 'files', scalar: true, maxFiles: 1, schema: { type: 'string' } };
  assert.deepEqual(Array.from(mediaFileValue(arrayField, ['https://example.com/image.png'])), ['https://example.com/image.png']);
  assert.equal(mediaFileValue(scalarField, ['https://example.com/image.png']), 'https://example.com/image.png');
  assert.equal(mediaFileValue(arrayField, []), undefined);
  assert.deepEqual(Array.from(normalizeMediaInput([arrayField], { input_urls: 'https://example.com/image.png' }).input_urls), ['https://example.com/image.png']);
  assert.equal(normalizeMediaInput([scalarField], { image_url: ['https://example.com/image.png'] }).image_url, 'https://example.com/image.png');
});
