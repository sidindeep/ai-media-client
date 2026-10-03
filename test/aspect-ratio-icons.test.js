const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { parse, compileScript, compileTemplate } = require('vue/compiler-sfc');
const { createSSRApp, h } = require('vue');
const { renderToString } = require('vue/server-renderer');

const cache = new Map();
function load(filename) {
  if (cache.has(filename)) return cache.get(filename);
  let source = fs.readFileSync(filename, 'utf8');
  if (filename.endsWith('.vue')) {
    const { descriptor } = parse(source, { filename });
    source = compileScript(descriptor, { id: path.basename(filename), inlineTemplate: true }).content;
  }
  const exports = {};
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(output, { exports, require: id => {
    if (id === 'vue') return require('vue');
    if (id.endsWith('/i18n')) return { t: key => key, useI18n: () => ({ t: key => key }) };
    const target = path.resolve(path.dirname(filename), id);
    if (id.endsWith('.json')) return require(target);
    return load(path.extname(target) ? target : target + '.ts');
  } });
  cache.set(filename, exports);
  return exports;
}
const root = path.join(__dirname, '../web/src');
const { aspectRatioFrame } = load(path.join(root, 'domain/aspect-ratios.ts'));

async function renderOpenPicker(props, slots = {}) {
  const filename = path.join(root, 'components/ParameterPicker.vue');
  const { descriptor } = parse(fs.readFileSync(filename, 'utf8'), { filename });
  const script = compileScript(descriptor, { id: 'open-picker-test' });
  const template = compileTemplate({ source: descriptor.template.content, filename, id: 'open-picker-test', compilerOptions: { bindingMetadata: script.bindings } });
  const exports = {};
  vm.runInNewContext(ts.transpileModule(script.content + '\n' + template.code, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
    { exports, require: id => id === 'vue' ? require('vue') : load(path.join(root, 'components/AppIcon.vue')) });
  const picker = exports.default;
  const setup = picker.setup;
  picker.setup = (values, context) => { const state = setup(values, context); state.open.value = true; return state; };
  picker.render = exports.render;
  const context = {};
  await renderToString(createSSRApp({ render: () => h(picker, props, slots) }), context);
  return context.teleports.body;
}

test('standard ratio indicators preserve aspect ratio, equal visual area and centering', () => {
  for (const value of ['1:1', '4:3', '3:4', '16:9', '9:16', '21:9', '3:2', '2:3', '4:5', '5:4']) {
    const [w, h] = value.split(':').map(Number);
    const frame = aspectRatioFrame(value);
    assert.ok(Math.abs(frame.width / frame.height - w / h) < 1e-10, value);
    assert.ok(Math.abs(frame.width * frame.height - 196) < 1e-10, value);
    assert.ok(Math.max(frame.width, frame.height) <= 22, value);
    assert.equal(frame.x + frame.width / 2, 12);
    assert.equal(frame.y + frame.height / 2, 12);
  }
  for (const value of ['auto', 'adaptive', '', '0:9', '16:0', 'unknown']) assert.equal(aspectRatioFrame(value), null);
});

test('extreme aspect ratios remain open frames in both orientations', async () => {
  const portrait = aspectRatioFrame('1:8');
  const landscape = aspectRatioFrame('8:1');
  assert.equal(portrait.width, landscape.height);
  assert.equal(portrait.height, landscape.width);
  const icon = load(path.join(root, 'components/AspectRatioIcon.vue')).default;
  for (const value of ['1:8', '8:1', '1:100', '100:1']) {
    const frame = aspectRatioFrame(value);
    assert.equal(Math.min(frame.width, frame.height), 6, 'short side leaves a visible interior at 20 px');
    assert.equal(Math.max(frame.width, frame.height), 22);
    assert.equal(frame.x + frame.width / 2, 12);
    assert.equal(frame.y + frame.height / 2, 12);
    const html = await renderToString(createSSRApp(icon, { value }));
    assert.match(html, /<rect /);
    assert.match(html, /rx="1.5"/);
    assert.match(html, /stroke-width="1.5"/);
  }
});

test('ratio SVG is decorative; adaptive uses expand and picker preserves provider values and labels', async () => {
  const icon = load(path.join(root, 'components/AspectRatioIcon.vue')).default;
  const square = await renderToString(createSSRApp(icon, { value: '1:1' }));
  assert.match(square, /aria-hidden="true"/);
  assert.match(square, /width="14" height="14"/);
  const adaptive = await renderToString(createSSRApp(icon, { value: 'adaptive' }));
  assert.match(adaptive, /sprite\.svg#fullscreen/);
  const picker = load(path.join(root, 'components/AspectRatioPicker.vue')).default;
  const html = await renderToString(createSSRApp(picker, { modelValue: 'adaptive', options: ['1:1', '21:9', 'adaptive'], optionLabels: { adaptive: 'Automatic' }, accessibleLabel: 'Aspect ratio', compact: true }));
  assert.match(html, /aria-label="Aspect ratio: Automatic"/);
  assert.match(html, /<strong>Automatic<\/strong>/);
  for (const value of ['1:1', '21:9', 'adaptive']) assert.ok(html.includes(`value="${value}"`));
  assert.match(html, /aria-haspopup="listbox"/);
});

test('open ratio menu keeps icons by default; resolution and duration explicitly hide option icons', async () => {
  const icon = load(path.join(root, 'components/AspectRatioIcon.vue')).default;
  const options = ['1:1', '16:9', '9:16', '3:2', '2:3', 'auto'].map(value => ({ value, label: value }));
  const ratios = await renderOpenPicker({ modelValue: '1:1', options }, { icon: ({ value }) => h(icon, { value }) });
  assert.equal((ratios.match(/aspect-frame-icon/g) || []).length, options.length);
  assert.equal((ratios.match(/<rect /g) || []).length, 5);
  assert.match(ratios, /sprite\.svg#fullscreen/);
  assert.doesNotMatch(ratios, /without-icons/);
  for (const name of ['resolution', 'duration']) {
    const html = await renderOpenPicker({ modelValue: '5', options: [{ value: '5', label: '5' }, { value: '10', label: '10' }], icon: name, menuIcons: false });
    assert.match(html, /without-icons/);
    assert.doesNotMatch(html, /parameter-picker-icon/);
    assert.match(html, /class="app-icon parameter-picker-check"/);
    assert.match(html, /d="M5 13L9 17L19 7"/);
  }
});

test('selected check remains visible independently of hover and uses the original Iconoir contour inline', async () => {
  const original = fs.readFileSync(path.join(root, '../public/iconoir/check.svg'), 'utf8');
  const checkPath = original.match(/<path d="([^"]+)"/)[1];
  const options = [{ value: '', label: 'Default' }, { value: 'std', label: '720p' }, { value: 'pro', label: '1080p' }];
  for (const modelValue of ['', 'std', 'pro']) {
    const html = await renderOpenPicker({ modelValue, options, icon: 'resolution', menuIcons: false });
    const rows = [...html.matchAll(/<button\b[^>]*role="option"[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]);
    assert.equal(rows.length, options.length);
    for (let index = 0; index < rows.length; index++) {
      const selected = options[index].value === modelValue;
      assert.ok(rows[index].includes(`aria-selected="${selected}"`));
      assert.ok(rows[index].includes(`d="${checkPath}"`), 'check is mounted in every reserved column');
      assert.equal(rows[index].includes('display:none'), !selected);
      assert.doesNotMatch(rows[index], /sprite\.svg#check/);
      assert.doesNotMatch(rows[index], /is-active/, 'opening with the mouse does not create a second selection highlight');
    }
  }
});

test('image primary settings select one set for the current provider and preserve catalog fields', () => {
  const { imagePrimaryFields, parameterIcon } = load(path.join(root, 'domain/image-settings.ts'));
  const aspect = { key: 'aspect_ratio', label: 'Aspect ratio', options: ['auto', '1:1', '16:9'] };
  const resolution = { key: 'resolution', label: 'Resolution', options: ['1K', '2K', '4K'] };
  const fields = [{ key: 'prompt' }, aspect, resolution, aspect, { key: 'quality', options: ['low', 'high'] }];
  const kie = imagePrimaryFields(fields, 'media');
  assert.equal(kie.length, 2);
  assert.equal(kie[0], aspect);
  assert.equal(kie[1], resolution);
  const apimart = imagePrimaryFields(fields, 'apimart');
  assert.equal(new Set(apimart.map(field => field.key)).size, apimart.length);
  assert.equal(imagePrimaryFields(fields, 'codex').length, 0);
  assert.equal(imagePrimaryFields(fields, 'routerai').length, 0);
  assert.equal(parameterIcon({ key: 'size', options: ['1:1'], optionLabels: { '1:1': 'Square image' } }), 'aspect-ratio');
  assert.equal(parameterIcon({ key: 'size', options: ['1024x1024'] }), 'resolution');
});

test('image toolbar renders one ratio and resolution control with the settings button', async () => {
  const toolbar = load(path.join(root, 'components/ImageSettingsBar.vue')).default;
  const fields = [
    { key: 'aspect_ratio', label: 'Aspect ratio', options: ['auto', '1:1', '16:9'] },
    { key: 'resolution', label: 'Resolution', options: ['1K', '2K', '4K'] },
  ];
  const html = await renderToString(createSSRApp(toolbar, { fields, values: { aspect_ratio: '16:9', resolution: '2K' }, errors: {}, expanded: false, showAdvanced: true }));
  assert.equal((html.match(/aria-label="Aspect ratio: 16:9"/g) || []).length, 1);
  assert.equal((html.match(/sprite\.svg#resolution/g) || []).length, 1);
  assert.match(html, /<select[^>]*value="2K"/);
  assert.match(html, /aria-controls="image-advanced-settings"/);
  assert.match(html, /sprite\.svg#settings/);
  const defaults = await renderToString(createSSRApp(toolbar, { fields, values: {}, errors: {}, expanded: false, allowDefault: true }));
  assert.match(defaults, /aria-label="Aspect ratio: common.default"/);
  assert.doesNotMatch(defaults, /aria-controls="image-advanced-settings"/);
});

test('all parameter pickers share the same trigger and keyboard selection preserves wire values', async () => {
  const duration = load(path.join(root, 'components/DurationPicker.vue')).default;
  const html = await renderToString(createSSRApp(duration, { modelValue: '8', options: [{ value: '4', label: '4 seconds' }, { value: '8', label: '8 seconds' }], label: 'Duration' }));
  assert.match(html, /class="parameter-picker-trigger"/);
  assert.match(html, /aria-label="Duration: 8 seconds"/);
  assert.match(html, /sprite\.svg#duration/);

  const filename = path.join(root, 'components/ParameterPicker.vue');
  const { descriptor } = parse(fs.readFileSync(filename, 'utf8'), { filename });
  const script = compileScript(descriptor, { id: 'picker-keyboard-test' });
  const exports = {};
  const emitted = [];
  const listeners = new Set();
  const events = { addEventListener: name => listeners.add(name), removeEventListener: name => listeners.delete(name) };
  vm.runInNewContext(ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports, window: { ...events, innerWidth: 1024, innerHeight: 768 }, document: events,
    require: id => id === 'vue' ? { ...require('vue'), useId: () => 'picker', watch: () => {}, onBeforeUnmount: () => {} } : {},
  });
  const state = exports.default.setup({ modelValue: 'std', options: [{ value: 'std', label: '720p' }, { value: 'pro', label: '1080p' }] }, { expose() {}, emit: (...args) => emitted.push(args) });
  let focused = false;
  state.trigger.value = { focus: () => { focused = true; }, getBoundingClientRect: () => ({ left: 10, top: 500, bottom: 534, width: 100 }) };
  state.place();
  assert.equal(state.position.value.maxHeight, 82, 'two compact rows plus padding and border fit without extra scrolling');
  state.trigger.value.getBoundingClientRect = () => ({ left: 970, top: 500, bottom: 534, width: 300 });
  state.menu.value = { getBoundingClientRect: () => ({ width: 108 }) };
  state.place();
  assert.equal(state.position.value.left, 906, 'viewport alignment uses content width instead of the wide trigger');
  state.menu.value = null;
  state.open.value = true;
  state.active.value = 0;
  let prevented = false;
  state.keydown({ key: 'ArrowDown', preventDefault: () => { prevented = true; } });
  assert.equal(state.active.value, 1);
  assert.equal(state.keyboardNavigation.value, true);
  assert.equal(prevented, true);
  state.keydown({ key: 'Enter', preventDefault() {} });
  assert.equal(emitted[0][0], 'update:modelValue');
  assert.equal(emitted[0][1], 'pro');
  assert.equal(state.open.value, false);
  assert.equal(focused, true);
  state.open.value = true;
  state.keydown({ key: 'Escape', preventDefault() {} });
  assert.equal(emitted.length, 1);
  assert.equal(state.open.value, false);
});
