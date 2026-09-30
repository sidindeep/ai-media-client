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
