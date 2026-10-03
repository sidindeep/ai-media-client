const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { createPinia, setActivePinia } = require('pinia');
const { nextTick } = require('vue');

function studioAt(path = '/app') {
  const location = new URL(path, 'http://localhost');
  const history = { state: { section: 'workspace' }, replaceState(state, _, url) {
    this.state = state;
    location.href = String(url);
  } };
  const source = fs.readFileSync(require.resolve('../web/src/stores/studio.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, URL, URLSearchParams, window: { location, history },
    require: name => name === '../i18n' ? { t: key => key } : name.startsWith('../') ? {} : require(name) });
  setActivePinia(createPinia());
  return { studio: exports.useStudioStore(), location, history };
}

test('admin switches presentation without changing role or draft, preserving URL context', async () => {
  const { studio, location, history } = studioAt('/app?order=keep#result');
  studio.accountRole = 'admin';
  studio.prompt = 'Draft';
  studio.modelAccess = 'gpt-only';
  studio.provider = 'media';
  studio.autoRouting = true;
  studio.sourceFiles = [{ ref: 'existing', name: 'input.png', type: 'image/png' }];
  const files = studio.sourceFiles;
  studio.toggleInterface();
  await nextTick();
  assert.equal(studio.isAdmin, false);
  assert.equal(studio.canAdmin, true);
  assert.equal(studio.accountRole, 'admin');
  assert.equal(studio.prompt, 'Draft');
  assert.equal(studio.sourceFiles, files);
  assert.equal(studio.autoRouting, true);
  assert.equal(studio.fullModelAccess, true);
  assert.equal(location.searchParams.get('interface'), 'user');
  assert.equal(location.searchParams.get('order'), 'keep');
  assert.equal(location.hash, '#result');
  assert.equal(history.state.section, 'workspace');
  studio.toggleInterface();
  assert.equal(studio.isAdmin, true);
  assert.equal(location.searchParams.has('interface'), false);
});

test('preview URL survives reload, and cannot grant admin presentation to a user', () => {
  const { studio, location } = studioAt('/app/history?interface=user');
  assert.equal(studio.isAdmin, false);
  assert.equal(studio.canAdmin, false);
  studio.toggleInterface();
  assert.equal(location.searchParams.get('interface'), 'user');
  studio.accountRole = 'admin';
  assert.equal(studio.isAdmin, false);
  studio.toggleInterface();
  assert.equal(studio.isAdmin, true);
});

test('revoking media access exits automatic routing and preserves the prompt', () => {
  const { studio } = studioAt();
  studio.prompt = 'Existing draft';
  studio.provider = 'media';
  studio.autoRouting = true;
  studio.mode = 'video';
  studio.setModelAccess('gpt-only');
  assert.equal(studio.provider, 'codex');
  assert.equal(studio.autoRouting, false);
  assert.equal(studio.mode, 'image');
  assert.equal(studio.prompt, 'Existing draft');
  assert.equal(studio.fullModelAccess, false);
});
