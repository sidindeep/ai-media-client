const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../web/src/domain/video-settings.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const moduleExports = {};
vm.runInNewContext(compiled, { exports: moduleExports,
  require: () => ({ mediaFieldOptions: field => field.options || field.schema?.enum || [] }) });
const { videoPrimaryFields, videoDurationOptions } = moduleExports;

test('video settings hide unsupported resolution and preserve catalog resolution choices', async () => {
  const { parse, compileScript } = require('vue/compiler-sfc');
  const { createSSRApp } = require('vue');
  const { renderToString } = require('vue/server-renderer');
  const componentSource = fs.readFileSync(path.join(__dirname, '../web/src/components/VideoSettingsBar.vue'), 'utf8');
  const { descriptor } = parse(componentSource);
  const script = compileScript(descriptor, { id: 'video-settings-test', inlineTemplate: true });
  const output = ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const componentExports = {};
  vm.runInNewContext(output, { exports: componentExports, require: id => {
    if (id === 'vue') return require('vue');
    if (id.endsWith('DurationPicker.vue')) return { default: { render: () => null } };
    if (id.endsWith('AspectRatioPicker.vue')) return { default: { render: () => null } };
    if (id.endsWith('AppIcon.vue')) return { default: { render: () => null } };
    if (id.endsWith('ParameterPicker.vue')) {
      const { descriptor: pickerDescriptor } = parse(fs.readFileSync(path.join(__dirname, '../web/src/components/ParameterPicker.vue'), 'utf8'));
      const pickerScript = compileScript(pickerDescriptor, { id: 'parameter-picker-test', inlineTemplate: true });
      const pickerExports = {};
      vm.runInNewContext(ts.transpileModule(pickerScript.content, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
        { exports: pickerExports, require: dependency => dependency === 'vue' ? require('vue') : { default: { render: () => null } } });
      return pickerExports;
    }
    if (id.endsWith('/video-settings')) return moduleExports;
    if (id.endsWith('/media-fields')) return { mediaFieldOptions: field => field.options || field.schema?.enum || [] };
    if (id === '../i18n') return { useI18n: () => ({ t: key => key }) };
    throw new Error(`Unexpected import: ${id}`);
  } });
  const { models } = require('../src/catalog');
  const kling = models.find(model => model.id === 'kie:kling/v2-5-turbo-text-to-video-pro');
  const render = fields => renderToString(createSSRApp(componentExports.default,
    { fields, values: {}, errors: {}, expanded: false }));
  const unavailable = await render(kling.fields);
  assert.doesNotMatch(unavailable, /composer\.unionField\.resolution/);
  assert.match(unavailable, /composer\.video\.aspect/);
  assert.match(unavailable, /composer\.video\.duration/);
  const withoutDuration = await render(kling.fields.filter(field => field.key !== 'duration'));
  assert.doesNotMatch(withoutDuration, /composer\.video\.duration/);
  const supported = await render([...kling.fields, { key: 'resolution', options: ['720p', '1080p'], default: '720p' }]);
  assert.match(supported, /composer\.unionField\.resolution/);
  assert.match(supported, /value="720p"/);
  assert.match(supported, /value="1080p"/);
  const motion = models.find(model => model.id === 'kie:kling-3.0/motion-control');
  const motionSettings = await render(motion.fields);
  assert.match(motionSettings, /composer\.unionField\.resolution/);
  assert.match(motionSettings, /value="720p"/);
  assert.match(motionSettings, /value="1080p"/);
  assert.doesNotMatch(motionSettings, /composer\.video\.duration/);
  const { describeModel } = require('../src/providers/apimart/catalog');
  for (const id of ['kling-v2-6-motion-control', 'kling-v3-motion-control']) {
    const apimart = describeModel({ id, category: 'video' });
    const apimartSettings = await render(apimart.fields);
    assert.match(apimartSettings, /composer\.unionField\.resolution/);
    assert.match(apimartSettings, /value="std"[^>]*>720p/);
    assert.match(apimartSettings, /value="pro"[^>]*>1080p/);
    assert.doesNotMatch(apimartSettings, /Standard|Pro ·/);
    assert.doesNotMatch(apimartSettings, /composer\.video\.duration/);
  }
});

test('video primary settings select quality aliases without consuming unrelated mode or frame counts', () => {
  const quality = { key: 'quality', options: ['720p'] }, duration = { key: 'duration' }, aspect = { key: 'aspect_ratio' };
  const fields = [{ key: 'mode', options: ['fun', 'normal'] }, { key: 'num_frames' }, duration, quality, aspect];
  const selected = videoPrimaryFields(fields);
  assert.equal(selected.aspect, aspect);
  assert.equal(selected.quality, quality);
  assert.equal(selected.duration, duration);
  assert.equal(videoPrimaryFields([{ key: 'num_frames' }]).duration, undefined);
  assert.equal(videoPrimaryFields([{ key: 'mode', options: ['720p', '1080p'] }]).quality.key, 'mode');
  assert.equal(videoPrimaryFields([{ key: 'quality' }, { key: 'resolution' }]).quality.key, 'resolution');
});

test('duration menu preserves discrete wire values and excludes automatic choices', () => {
  assert.deepEqual(Array.from(videoDurationOptions({ key: 'duration', options: ['5', '10', '15'] })), ['5', '10', '15']);
  assert.deepEqual(Array.from(videoDurationOptions({ key: 'duration', options: [-1, 4, 5] })), [4, 5]);
  assert.deepEqual(Array.from(videoDurationOptions({ key: 'duration', options: ['auto', '5'] })), ['5']);
  assert.deepEqual(Array.from(videoDurationOptions({ key: 'duration', options: [0, '4', '5'] })), ['4', '5']);
  assert.deepEqual(Array.from(videoDurationOptions({ key: 'duration', type: 'number' })), []);
});

test('duration uses schema constraints and effective catalog allow-list without Seedance 2.5 automatic duration', () => {
  const schema = videoDurationOptions({ key: 'duration', schema: { minimum: 2, maximum: 15, type: 'integer' } });
  assert.equal(schema[0], 2); assert.equal(schema.at(-1), 15); assert.equal(schema.length, 14);
  const { models: catalog } = require('../src/catalog');
  const field = catalog.find(model => model.id === 'kie:bytedance/seedance-2-5').fields.find(field => field.key === 'duration');
  const options = videoDurationOptions(field);
  assert.equal(options[0], 4);
  assert.equal(options.includes(-1), false);
  assert.equal(options.at(-1), 30);
  assert.equal(options.includes(7), true);
  assert.equal(options.includes(3), false);
});

test('duration menu respects bounded increments and avoids inventing choices for continuous ranges', () => {
  assert.deepEqual(Array.from(videoDurationOptions({ key: 'duration', min: 4, max: 10, step: 2 })), [4, 6, 8, 10]);
  assert.deepEqual(Array.from(videoDurationOptions({ key: 'duration', min: 1, max: 2, step: 0.5 })), [1, 1.5, 2]);
  assert.deepEqual(Array.from(videoDurationOptions({ key: 'duration', min: 5, max: 5 })), [5]);
  assert.deepEqual(Array.from(videoDurationOptions({ key: 'duration', min: 1, max: 10, step: 'any' })), []);
  assert.deepEqual(Array.from(videoDurationOptions({ key: 'duration', min: 1, max: 10000 })), []);
});
