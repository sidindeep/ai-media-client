const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const ts = require('typescript');

test('generation credit costs are always displayed rounded up', async () => {
  const source = await fs.readFile(path.join(__dirname, '../web/src/domain/credits.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
  const { formatCreditCost, roundedCreditCost } = await import(`data:text/javascript,${encodeURIComponent(compiled)}`);

  assert.equal(roundedCreditCost(879.43875), 880);
  assert.equal(formatCreditCost(879.43875), '880');
  assert.equal(formatCreditCost(0.001), '1');
  assert.equal(formatCreditCost(4), '4');
});
