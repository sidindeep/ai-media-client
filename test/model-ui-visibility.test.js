const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { applyModelUiVisibility, visibleUiInput } = require('../src/model-ui-visibility');
const policy = require('../config/model-ui-parameters.json');
const { describeModel } = require('../src/providers/apimart/catalog');

function withoutMarkers(value) {
  return JSON.parse(JSON.stringify(value, (key, child) => ['uiHidden', 'uiHiddenReason', 'uiVisibleReason'].includes(key) ? undefined : child));
}

test('provider columns are independent, and marking does not alter API contracts or input sources', () => {
  const model = { id: 'fixture', fields: ['negative_prompt', 'audio_url', 'pe_fast_mode'].map(key =>
    ({ key, default: false, required: false, schema: { type: 'boolean', default: false } })),
  inputSchema: { type: 'object', required: [], properties: { pe_fast_mode: { type: 'boolean', default: false } } } };
  const original = structuredClone(model);
  const kie = applyModelUiVisibility(model, 'kie'), apimart = applyModelUiVisibility(model, 'apimart');
  assert.deepEqual(kie.fields.filter(f => f.uiHidden).map(f => f.key), ['negative_prompt', 'pe_fast_mode']);
  assert.deepEqual(apimart.fields.filter(f => f.uiHidden).map(f => f.key), ['audio_url', 'pe_fast_mode']);
  assert.deepEqual(withoutMarkers(kie), original);
  assert.deepEqual(withoutMarkers(apimart), original);
  assert.deepEqual(model, original);
  for (const provider of ['codex', 'routerai', 'other']) assert.equal(applyModelUiVisibility(model, provider), model);
});

test('all Kie and APIMart fields follow their column; shared APIMart metadata is not mutated', () => {
  const kie = require('../src/catalog').models;
  const metadata = require('../config/apimart-schemas.json').models;
  const before = structuredClone(metadata);
  const apimart = Object.entries(metadata).map(([id, model]) => describeModel({ id, category:
    model.endpoint.includes('music') || model.endpoint.includes('audio') ? 'audio'
      : model.endpoint.includes('image') ? 'image' : model.endpoint.includes('video') ? 'video' : 'chat' }));
  for (const [provider, models] of [['kie', kie], ['apimart', apimart]]) {
    const allowed = new Set(policy.parameters.flatMap(row => row[provider]));
    for (const model of models) for (const field of model.fields) {
      assert.equal(Boolean(field.uiHidden), field.key !== '__input' && !allowed.has(field.key) && !field.uiVisibleReason, `${provider}:${model.id}:${field.key}`);
      if (field.uiHidden) assert.equal(field.uiHiddenReason, 'absent-from-ui-parameter-table');
      if (field.required) assert.ok(!field.uiHidden, `${model.id}:${field.key} must be editable`);
    }
    function checkSchema(schema, inheritedHidden = false) {
      if (!schema) return;
      const hidden = inheritedHidden || Boolean(schema.uiHidden);
      for (const [key, child] of Object.entries(schema.properties || {})) {
        if (schema.required?.includes(key)) assert.ok(!hidden && !child.uiHidden, `${provider}: inaccessible required ${key}`);
        checkSchema(child, hidden);
      }
      checkSchema(schema.items, hidden);
      for (const kind of ['oneOf', 'anyOf', 'allOf']) for (const branch of schema[kind] || []) checkSchema(branch, hidden);
      for (const kind of ['then', 'else']) checkSchema(schema[kind], hidden);
    }
    for (const model of models) { checkSchema(model.inputSchema); for (const field of model.fields) checkSchema(field.schema, field.uiHidden); }
  }
  assert.deepEqual(metadata, before);
});

test('required nested values and their optional containers stay editable without changing API contracts', () => {
  const schema = { type: 'object', required: ['multi_prompt'], properties: { multi_prompt: {
    type: 'array', items: { type: 'object', required: ['prompt', 'duration'], properties: {
      prompt: { type: 'string' }, duration: { type: 'integer', default: 5 }, extra: { type: 'string' } } } } } };
  const model = { fields: [{ key: '__input', schema: { oneOf: [schema] } }], inputSchema: { anyOf: [schema] } };
  const marked = applyModelUiVisibility(model, 'apimart');
  const multi = marked.inputSchema.anyOf[0].properties.multi_prompt;
  assert.equal(multi.uiHidden, undefined);
  assert.equal(multi.items.uiHidden, undefined);
  assert.equal(multi.items.properties.prompt.uiHidden, undefined);
  assert.equal(multi.items.properties.duration.uiHidden, undefined);
  assert.equal(multi.items.properties.prompt.uiVisibleReason, 'required-for-generation');
  assert.equal(multi.items.properties.extra.uiHidden, true);
  assert.equal(marked.fields[0].schema.oneOf[0].properties.multi_prompt.items.properties.prompt.uiHidden, undefined);
  assert.deepEqual(withoutMarkers(marked), model);
  const displayModel = { fields: [{ key: 'multi_prompt', schema: multi }] };
  const input = { multi_prompt: [{ prompt: 'Saved', duration: 5 }] };
  assert.deepEqual(visibleUiInput(displayModel, input), input);
  assert.equal(input.multi_prompt[0].prompt, 'Saved');
  const kie = applyModelUiVisibility(model, 'kie');
  assert.equal(kie.inputSchema.anyOf[0].properties.multi_prompt.uiHidden, undefined);
  assert.equal(kie.inputSchema.anyOf[0].properties.multi_prompt.uiVisibleReason, 'required-for-generation');
  const optional = { fields: [{ key: 'color_palette', required: false, schema: { type: 'array', items: {
    type: 'object', required: ['hex', 'ratio'], properties: { hex: { type: 'string' }, ratio: { type: 'number' } } } } }] };
  const palette = applyModelUiVisibility(optional, 'kie').fields[0];
  assert.equal(palette.required, false);
  assert.equal(palette.uiHidden, undefined);
  assert.equal(palette.uiVisibleReason, 'required-child-container');
  assert.equal(palette.schema.items.properties.hex.uiHidden, undefined);
});

test('required exceptions are model-specific and restore the approved top-level keys', () => {
  const kie = require('../src/catalog').models;
  const required = kie.flatMap(model => model.fields.filter(field => field.uiVisibleReason === 'required-for-generation').map(field => field.key));
  assert.deepEqual([...new Set(required)].sort(), ['audio_id', 'full_lyrics', 'infill_end_s', 'infill_start_s', 'model', 'stem_name', 'title']);
  const title = { fields: [{ key: 'title', required: false }] };
  assert.equal(applyModelUiVisibility(title, 'kie').fields[0].uiHidden, true);
  assert.equal(applyModelUiVisibility({ fields: [{ key: 'title', required: true }] }, 'kie').fields[0].uiHidden, undefined);
  for (const id of ['kling-v2-6-motion-control', 'kling-v3-motion-control', 'wan2.7-videoedit']) {
    const model = describeModel({ id, category: 'video' });
    const field = model.fields.find(field => field.key === (id.startsWith('wan') ? 'video_urls' : 'video_url'));
    assert.equal(field.required, true);
    assert.equal(field.uiHidden, undefined);
    assert.equal(field.uiVisibleReason, 'required-for-generation');
  }
  for (const id of ['kling-v2-6-motion-control', 'kling-v3-motion-control']) {
    const model = describeModel({ id, category: 'video' });
    const mode = model.fields.find(field => field.key === 'mode');
    assert.equal(mode.label, 'Качество');
    assert.equal(mode.default, 'std');
    assert.deepEqual(mode.options, ['std', 'pro']);
    assert.deepEqual(mode.optionLabels, { std: '720p', pro: '1080p' });
  }
});

test('Suno input modes expose both their own and common required fields', () => {
  const ts = require('typescript');
  const source = fs.readFileSync(path.join(__dirname, '../web/src/domain/union-model-fields.ts'), 'utf8');
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports, require: id => id.endsWith('/parameter-labels')
      ? { parameterLabel: (_key, label) => label, localizeParameterFields: fields => fields }
      : { t: key => key },
  });
  const model = require('../src/catalog').models.find(model => model.id === 'kie:ai-music-api/replace-section');
  for (const index of [0, 1]) {
    const fields = exports.unionFields(model, index);
    for (const key of ['title', 'infill_start_s', 'infill_end_s', 'full_lyrics']) {
      const field = fields.find(field => field.key === key);
      assert.equal(field.required, true, key);
      assert.equal(field.uiHidden, false, key);
    }
    const field = fields.find(field => field.key === (index ? 'model' : 'audio_id'));
    assert.equal(field.required, true);
    assert.equal(field.uiHidden, false);
  }
  const separation = require('../src/catalog').models.find(model => model.apiModel === 'ai-music-api/separate-vocals');
  for (const index of [0, 1]) {
    for (const type of ['separate_vocal', 'split_stem', 'split_stem_advanced']) {
      const fields = exports.unionFields(separation, index, { type });
      const stem = fields.find(field => field.key === 'stem_name');
      assert.equal(stem.required, type === 'split_stem_advanced');
      assert.equal(stem.uiHidden, false);
      assert.equal(fields.find(field => field.key === 'type').uiHidden, false);
      const audio = fields.find(field => field.key === (index ? 'audio_url' : 'audio_id'));
      assert.equal(audio.required, true);
      assert.equal(audio.uiHidden, false);
      if (index) assert.equal(fields.some(field => ['task_id', 'audio_id'].includes(field.key)), false);
      else assert.equal(fields.find(field => field.key === 'task_id').required, true);
    }
    assert.equal(exports.unionFields(separation, index).find(field => field.key === 'stem_name').required, false);
  }
});

test('Telegram uses trusted roles for menus/draft previews and retains saved hidden inputs', async t => {
  const fsp = require('node:fs/promises');
  const os = require('node:os');
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'media-visibility-test-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const model = require('../src/catalog').models.find(item => item.id === 'kie:omnihuman-1-5');
  const service = { catalog: () => ({ models: [model] }), findModel: () => model };
  let role = 'user';
  const bot = require('../src/services/telegram-bot').createTelegramBot({ service, directory,
    resolveAccount: async () => ({ service, accountId: 'fixture', role }) });
  const message = text => ({ message: { text, chat: { id: 7, type: 'private' }, from: { id: 7 } } });
  const buttons = response => response.reply_markup.inline_keyboard.flat().map(item => item.callback_data);
  const index = model.fields.findIndex(field => field.key === 'pe_fast_mode');
  assert.equal(buttons(await bot.handle(message('/settings'))).includes(`field:${index}`), false);
  await bot.handle(message('/set pe_fast_mode true'));
  assert.doesNotMatch((await bot.handle(message('/draft'))).text, /pe_fast_mode/);
  assert.equal((await bot.sessions.list())[0].input.pe_fast_mode, true);
  role = 'admin';
  assert.equal(buttons(await bot.handle(message('/settings'))).includes(`field:${index}`), true);
  assert.match((await bot.handle(message('/draft'))).text, /"pe_fast_mode": true/);
});

function loadFrontendDomain() {
  const ts = require('typescript');
  const source = fs.readFileSync(path.join(__dirname, '../web/src/domain/model-ui-visibility.ts'), 'utf8');
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
    { exports, structuredClone });
  return exports;
}

test('user filtering preserves draft inputs and leaves every field available to administrators', () => {
  const { userVisibleFields, hiddenRequiredPaths, schemaInitialValue } = loadFrontendDomain();
  const fields = [{ key: 'prompt' }, { key: 'audio_id', uiHidden: true, required: true }, { key: 'pe_fast_mode', uiHidden: true }];
  assert.equal(userVisibleFields(fields, true), fields);
  assert.deepEqual(Array.from(userVisibleFields(fields, false), f => f.key), ['prompt']);
  assert.deepEqual(Array.from(hiddenRequiredPaths(fields, { pe_fast_mode: false })), ['audio_id']);
  assert.deepEqual(Array.from(hiddenRequiredPaths(fields, { audio_id: 'saved', pe_fast_mode: false })), []);
  const nested = [{ key: 'elements', schema: { type: 'array', items: { type: 'object', required: ['duration'],
    properties: { duration: { type: 'integer', uiHidden: true, default: 5 } } } } }];
  assert.deepEqual(Array.from(hiddenRequiredPaths(nested, {})), []);
  assert.deepEqual(Array.from(hiddenRequiredPaths(nested, { elements: [{}] })), ['elements[0].duration']);
  assert.equal(schemaInitialValue(nested[0].schema.items).duration, 5);
  assert.equal(schemaInitialValue({ type: 'object', required: ['id'], properties: { id: { type: 'string' } } }).id, undefined);
});

test('SchemaField recursively hides marked controls for users and renders them for administrators', async () => {
  const ts = require('typescript');
  const { parse, compileScript } = require('vue/compiler-sfc');
  const { createSSRApp } = require('vue');
  const { renderToString } = require('vue/server-renderer');
  const { descriptor } = parse(fs.readFileSync(path.join(__dirname, '../web/src/components/SchemaField.vue'), 'utf8'), { filename: 'SchemaField.vue' });
  const source = compileScript(descriptor, { id: 'schema-visibility', inlineTemplate: true }).content;
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
    { exports, structuredClone, require: id => {
      if (id === 'vue') return require('vue');
      // Decorative icons do not affect the recursive field-visibility contract.
      if (id === './AppIcon.vue') return { default: { render: () => null } };
      if (id.endsWith('/model-ui-visibility')) return loadFrontendDomain();
      if (id.endsWith('/source-attachments')) return {};
      if (id.endsWith('/studio')) return { useStudioStore: () => ({ sourceFiles: [] }) };
      if (id.endsWith('/parameter-labels')) return { parameterLabel: (_name, label) => label };
      if (id === '../i18n') return { useI18n: () => ({ t: key => key }) };
      throw new Error(`Unexpected import ${id}`);
    } });
  const schema = { type: 'array', items: { type: 'object', properties: {
    visible: { type: 'string' }, secret: { type: 'string', uiHidden: true } } } };
  const render = showHidden => renderToString(createSSRApp(exports.default, { schema, showHidden, rootKey: 'elements', name: 'elements', label: 'Elements',
    modelValue: [{ visible: 'Visible value', secret: 'Hidden value' }] }));
  assert.doesNotMatch(await render(false), /Hidden value|>secret/);
  assert.match(await render(true), /Hidden value/);
});
