const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

test('generation credit costs keep the wallet precision of 0.001 credits', async () => {
  const source = await fs.readFile(path.join(__dirname, '../web/src/domain/credits.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const filename = path.join(__dirname, '../web/src/domain/credits.ts');
  const creditsModule = new Module(filename, module);
  creditsModule.require = id => {
    assert.equal(id, '../i18n');
    return { formatNumber: (value, options) => new Intl.NumberFormat('ru', options).format(value) };
  };
  creditsModule._compile(compiled, filename);
  const { formatCreditCost, roundedCreditCost } = creditsModule.exports;

  assert.equal(roundedCreditCost(879.43875), 879.439);
  assert.equal(formatCreditCost(879.43875), '879,439');
  assert.equal(formatCreditCost(0.001), '0,001');
  assert.equal(formatCreditCost(4), '4');
});
