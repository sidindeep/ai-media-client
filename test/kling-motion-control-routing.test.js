const test = require('node:test');
const assert = require('node:assert/strict');
const { rawTask } = require('../src/media/generation-task');
const { prepareTask: prepareApimartTask } = require('../src/providers/apimart/task-adapter');
const { prepareTask: prepareKieTask } = require('../src/providers/kie/task-adapter');
const { describeModel } = require('../src/providers/apimart/catalog');
const { models } = require('../src/catalog');

// Isolate resolution translation from source transport and duration pricing.
for (const [kieId, apimartId] of [
  ['kie:kling-2.6/motion-control', 'kling-v2-6-motion-control'],
  ['kie:kling-3.0/motion-control', 'kling-v3-motion-control'],
]) {
  for (const [resolution, mode] of [['720p', 'std'], ['1080p', 'pro']]) {
    test(`${kieId}: ${resolution} maps to APIMart ${mode} and back without mutating input`, () => {
      const apimart = describeModel({ id: apimartId, category: 'video' });
      const kie = models.find(model => model.id === kieId);
      const apimartModeModel = { ...apimart, fields: apimart.fields.filter(field => field.key === 'mode') };
      const kieModeModel = { ...kie, inputSchema: { type: 'object', required: ['mode'],
        properties: { mode: kie.inputSchema.properties.mode } } };
      const kieRaw = { modelId: kieId, input: { mode: resolution } };
      const apimartRaw = { modelId: `apimart:${apimartId}`, input: { mode } };
      const toApimart = prepareApimartTask(rawTask(kieRaw), apimartModeModel);
      assert.equal(toApimart.parameters.mode, mode);
      const toKie = prepareKieTask(rawTask(apimartRaw), kieModeModel);
      assert.equal(toKie.input.mode, resolution);
      assert.deepEqual(kieRaw.input, { mode: resolution });
      assert.deepEqual(apimartRaw.input, { mode });
      assert.throws(() => prepareApimartTask(rawTask({ ...kieRaw, input: { mode: '4k' } }), apimartModeModel), /Значение mode/);
      assert.throws(() => prepareKieTask(rawTask({ ...apimartRaw, input: { mode: '4k' } }), kieModeModel), /Значение mode/);
    });
  }
}

test('resolution aliases do not change mode for unrelated models', () => {
  const task = rawTask({ modelId: 'kie:other', input: { mode: '720p' } });
  assert.throws(() => prepareApimartTask(task, { id: 'kling-v3', fields: [
    { key: 'mode', options: ['std', 'pro'] } ] }), /Значение mode/);
});
