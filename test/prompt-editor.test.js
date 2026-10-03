const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { parse, compileScript, compileStyle } = require('vue/compiler-sfc');

function editor() {
  const filename = path.resolve(__dirname, '../web/src/components/PromptEditor.vue');
  const { descriptor } = parse(fs.readFileSync(filename, 'utf8'));
  const source = compileScript(descriptor, { id: 'prompt-editor-test' }).content;
  const compiled = new Module(filename, module);
  let unmount;
  compiled.require = id => {
    if (id === 'vue') return {
      ref: value => ({ value }), nextTick: async () => {}, useId: () => 'prompt-title',
      onMounted: () => {}, onBeforeUnmount: callback => { unmount = callback; },
      defineComponent: options => options,
    };
    if (id === '../i18n') return { useI18n: () => ({ t: key => key }) };
    if (id === '../domain/prompt-scroll') return { createPromptLineScroll: () => ({ cancel() {} }) };
    if (id === './AppIcon.vue') return {};
    throw new Error(`Unexpected dependency: ${id}`);
  };
  compiled._compile('const document = { documentElement: { style: { overflow: "auto" } } }; exports.page = document;\n'
    + 'const window = { removeEventListener() {} };\n'
    + ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText, filename);
  let prompt = 'first line\nsecond line\nthird line';
  const state = compiled.exports.default.setup({ modelValue: prompt, placeholder: '' }, {
    expose() {}, emit: (name, value) => { if (name === 'update:modelValue') prompt = value; },
  });
  const textarea = () => ({ selectionStart: 4, selectionEnd: 18, selectionDirection: 'backward',
    focused: false, focus() { this.focused = true; },
    setSelectionRange(start, end, direction) { Object.assign(this, { selectionStart: start, selectionEnd: end, selectionDirection: direction }); },
  });
  state.compact.value = textarea();
  state.expanded.value = textarea();
  state.dialog.value = { open: false, showModal() { this.open = true; }, close() { this.open = false; } };
  return { state, page: compiled.exports.page, unmount: () => unmount(), prompt: () => prompt };
}

test('expanded editor keeps the shared draft and selection across closing', async () => {
  const { state, page, prompt } = editor();
  await state.openEditor();
  assert.equal(state.dialog.value.open, true);
  assert.equal(page.documentElement.style.overflow, 'hidden');
  assert.equal(state.expanded.value.focused, true);
  assert.equal(state.expanded.value.selectionEnd, 18);
  assert.equal(state.expanded.value.selectionDirection, 'backward');
  state.update({ target: { value: 'edited line\nsecond edited line' } });
  assert.equal(prompt(), 'edited line\nsecond edited line', 'draft updates immediately without a save step');
  state.expanded.value.setSelectionRange(0, 24, 'forward');
  state.closeEditor();
  assert.equal(state.dialog.value.open, false);
  assert.equal(page.documentElement.style.overflow, 'auto');
  assert.equal(state.compact.value.focused, true);
  assert.deepEqual([state.compact.value.selectionStart, state.compact.value.selectionEnd, state.compact.value.selectionDirection], [0, 24, 'forward']);
  assert.equal(prompt(), 'edited line\nsecond edited line', 'closing does not restore stale text');
});

test('unmounting an open editor releases page scrolling and keeps edits', async () => {
  const { state, page, unmount, prompt } = editor();
  await state.openEditor();
  state.update({ target: { value: 'saved draft' } });
  unmount();
  assert.equal(state.dialog.value.open, false);
  assert.equal(page.documentElement.style.overflow, 'auto');
  assert.equal(prompt(), 'saved draft');
});

test('compiled theme rules target the editor and keep text readable in both themes', () => {
  const filename = path.resolve(__dirname, '../web/src/components/PromptEditor.vue');
  const { descriptor } = parse(fs.readFileSync(filename, 'utf8'));
  const style = compileStyle({ source: descriptor.styles[0].content, id: 'data-v-theme-test', scoped: true });
  assert.deepEqual(style.errors, []);
  const rules = [];
  style.rawResult.root.walkRules(rule => { rules.push(rule); });
  const lightRules = rules.filter(rule => rule.selector.includes(':root'));
  assert.ok(lightRules.length);
  for (const rule of lightRules) for (const selector of rule.selector.split(',')) {
    assert.match(selector, /:root\[data-theme='light'\]\s+\.prompt-/,
      'theme styling must not leak onto the root when Vue compiles scoped CSS');
    assert.ok(selector.includes('[data-v-theme-test]'), 'the target stays component-scoped');
  }
  function contrast(rule) {
    const declarations = Object.fromEntries(rule.nodes.filter(node => node.type === 'decl').map(node => [node.prop, node.value]));
    function luminance(color) {
      assert.match(color, /^#[\da-f]{3}(?:[\da-f]{3})?$/i, 'text and background use explicit colors');
      const hex = color.length === 4 ? color.slice(1).split('').map(x => x + x).join('') : color.slice(1);
      const rgb = hex.match(/../g).map(x => parseInt(x, 16) / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4);
      return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
    }
    const text = luminance(declarations.color), background = luminance(declarations.background);
    return (Math.max(text, background) + .05) / (Math.min(text, background) + .05);
  }
  const dark = rules.find(rule => rule.selector === '.prompt-editor-textarea[data-v-theme-test]');
  const light = lightRules.find(rule => rule.selector.includes('.prompt-editor-textarea'));
  assert.ok(contrast(dark) >= 4.5, 'dark editor text is readable');
  assert.ok(contrast(light) >= 4.5, 'light editor text is readable');
});
