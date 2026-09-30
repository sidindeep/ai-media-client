const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { effectScope } = require('vue');
const { publicRows } = require('../src/services/model-route-document');
const document = require('../config/model-routes.json');

function studio() {
  const filename = path.resolve(__dirname, '../web/src/stores/studio.ts');
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const compiled = new Module(filename, module);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = compiled.require.bind(compiled);
  compiled.require = id => {
    if (id === 'pinia') return { defineStore: (_id, setup) => setup };
    if (id === '../api/client') return {};
    if (id === '../i18n') return { t: key => key };
    if (id === '../domain/media-fields') return { normalizeMediaInput: (_model, input) => input, mediaFileValue: (_field, refs) => refs };
    return original(id);
  };
  compiled._compile(output, filename);
  return compiled.exports.useStudioStore();
}

test('automatic menu keeps distinct drafts for actions sharing one APIMart ID', t => {
  const scope = effectScope(); t.after(() => scope.stop());
  const store = scope.run(studio);
  store.serviceModelConfig.value = { id: 'model-routes', models: publicRows(document.models) };
  store.mode.value = 'image';
  store.provider.value = 'apimart';
  store.autoRouting.value = true;
  store.setAutoModel('gpt-image-2.image-to-image');
  const ref = 'content:55555555-5555-4555-8555-555555555555';
  store.mediaInput.value = { image_urls: [ref], resolution: '1K' };
  store.sourceFiles.value = [{ ref, name: 'source.png', type: 'image/png' }];
  store.setAutoModel('gpt-image-2.text-to-image');
  assert.equal(store.autoModelId.value, 'gpt-image-2.text-to-image');
  assert.equal(store.apimartModel.value, 'gpt-image-2');
  assert.deepEqual(store.sourceFiles.value, []);
  assert.equal(store.mediaInput.value.image_urls, undefined);
  store.mediaInput.value = { resolution: '2K' };
  store.setAutoModel('gpt-image-2.image-to-image');
  assert.equal(store.autoModelId.value, 'gpt-image-2.image-to-image');
  assert.deepEqual(store.mediaInput.value.image_urls, [ref]);
  assert.equal(store.sourceFiles.value[0].ref, ref);
  store.setAutoModel('gpt-image-2.text-to-image');
  assert.equal(store.mediaInput.value.resolution, '2K');
  store.setAutoModel('image.seedream.5-pro-layer-decomposition');
  assert.equal(store.mediaInput.value.layer_decomposition, true);
});
