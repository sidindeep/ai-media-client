const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const filename = path.resolve(__dirname, '../web/src/popups/service.ts');
const compiled = new Module(filename, module);
compiled.filename = filename;
compiled.paths = Module._nodeModulePaths(path.dirname(filename));
compiled._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText, filename);
const { createPopupService } = compiled.exports;

test('popups queue requests and distinguish cancellation from successful empty project selection', async () => {
  const popup = createPopupService();
  let writes = 0;
  const prompt = popup.prompt({ title: 'Name', label: 'Name', onConfirm: () => { writes++; } });
  const confirmation = popup.confirm({ title: 'Archive', onConfirm: () => { writes++; } });
  const selection = popup.select({ title: 'Project', label: 'Project', options: [{ value: '', label: 'None' }, { value: 'id', label: 'Same' }] });
  assert.equal(popup.active.value.kind, 'prompt');
  popup.cancel();
  assert.equal(await prompt, null);
  assert.equal(popup.active.value.kind, 'confirm');
  popup.cancel();
  assert.equal(await confirmation, false);
  assert.equal(writes, 0);
  await popup.submit('unknown');
  assert.equal(popup.active.value.kind, 'select');
  await popup.submit('');
  assert.equal(await selection, '');
  assert.equal(popup.active.value, null);
});

test('input validation, duplicate submit and cancellation cannot race a pending operation', async () => {
  const popup = createPopupService();
  let release, writes = 0;
  const saved = popup.prompt({ title: 'Name', label: 'Name', maxLength: 5,
    onConfirm: async name => { assert.equal(name, 'Chat'); writes++; await new Promise(resolve => { release = resolve; }); },
  });
  await popup.submit('   ');
  await popup.submit('Too long');
  assert.equal(writes, 0);
  const operation = popup.submit(' Chat ');
  assert.equal(popup.busy.value, true);
  await popup.submit('Again');
  popup.cancel();
  assert.equal(writes, 1);
  assert.equal(popup.active.value.kind, 'prompt');
  release();
  await operation;
  assert.equal(await saved, 'Chat');
  assert.equal(popup.busy.value, false);
});

test('failed business operation keeps input popup open for retry and does not advance queue', async () => {
  const popup = createPopupService();
  let attempts = 0;
  const saved = popup.prompt({ title: 'Name', label: 'Name', onConfirm: () => {
    if (++attempts === 1) throw new Error('Connection failed');
  } });
  const next = popup.alert({ title: 'Done' });
  await popup.submit('Retry');
  assert.equal(popup.error.value, 'Connection failed');
  assert.equal(popup.busy.value, false);
  assert.equal(popup.active.value.kind, 'prompt');
  await popup.submit('Retry');
  assert.equal(await saved, 'Retry');
  assert.equal(popup.error.value, null);
  assert.equal(popup.active.value.kind, 'alert');
  await popup.submit();
  assert.equal(await next, undefined);
});

test('teardown settles every pending promise and late operation cannot close a new popup', async () => {
  const popup = createPopupService();
  let release;
  const first = popup.confirm({ title: 'Save', onConfirm: () => new Promise(resolve => { release = resolve; }) });
  const second = popup.prompt({ title: 'Queued', label: 'Name' });
  const operation = popup.submit();
  popup.dismissAll();
  assert.equal(await first, false);
  assert.equal(await second, null);
  const next = popup.confirm({ title: 'New' });
  release();
  await operation;
  assert.equal(popup.active.value.title, 'New');
  popup.cancel();
  assert.equal(await next, false);
});
