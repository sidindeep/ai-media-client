const test = require('node:test');
const assert = require('node:assert/strict');
const { readTask, prepareTask } = require('../src/providers/apimart/task-adapter');
const { describeModel } = require('../src/providers/apimart/catalog');
const { normalizedRequest } = require('../src/services/cost-router');
const { prepareTask: prepareKieTask } = require('../src/providers/kie/task-adapter');
const { models } = require('../src/catalog');
const ref = 'content:55555555-5555-4555-8555-555555555555';
const last = 'content:66666666-6666-4666-8666-666666666666';
const model = id => describeModel({ id, category: 'video' });
function prepare(id, action, input, origin = `apimart:${id}`) {
  const task = readTask({ modelId: origin, action, input: { prompt: 'Animate', ...input }, sourceFiles: [] });
  return prepareTask(task, model(id)).parameters;
}

test('APIMart Veo encodes frame and reference modes even with a single image', () => {
  const frames = prepare('veo3.1-fast', 'first-last-frame-to-video', { image_urls: [ref, last] });
  assert.equal(frames.generation_type, 'frame');
  assert.deepEqual(frames.image_urls, [ref, last]);
  const references = prepare('veo3.1-fast', 'reference-to-video', { image_urls: [ref] });
  assert.equal(references.generation_type, 'reference');
  assert.deepEqual(references.image_urls, [ref]);
  assert.throws(() => prepare('veo3.1-fast', 'text-to-video', { generation_type: 'frame' }), /противоречат/);
  assert.throws(() => prepare('veo3.1-fast', 'reference-to-video', { image_urls: [ref], generation_type: 'frame' }), /противоречит/);
  assert.throws(() => prepare('veo3.1-lite', 'reference-to-video', { image_urls: [ref] }), /не поддерживает/);
});

test('Veo APIMart frames can return to the exact Kie frame variant', () => {
  const task = normalizedRequest({ modelId: 'video.veo3_fast.first_and_last_frames_2_video',
    originModelId: 'apimart:veo3.1-fast', input: { prompt: 'Animate', image_urls: [ref, last], duration: 8 } }).task;
  const result = prepareKieTask(task, models.find(model => model.id === 'kie:veo3_fast:FIRST_AND_LAST_FRAMES_2_VIDEO'));
  assert.equal(result.input.firstFrame, ref);
  assert.equal(result.input.lastFrame, last);
  const explicit = normalizedRequest({ modelId: 'video.veo3_fast.first_and_last_frames_2_video',
    originModelId: 'apimart:veo3.1-fast', input: { prompt: 'Animate', image_urls: [ref, last], generation_type: 'frame' } }).task;
  assert.ok(prepareKieTask(explicit, models.find(model => model.id === 'kie:veo3_fast:FIRST_AND_LAST_FRAMES_2_VIDEO')));
});

test('PixVerse keeps reference, transition and extension triggers separate', () => {
  const references = prepare('pixverse-v6', 'reference-to-video', { img_references: [ref] });
  assert.deepEqual(references.img_references, [ref]);
  assert.equal(references.image_urls, undefined);
  const frames = prepare('pixverse-v6', 'first-last-frame-to-video', { first_frame_image: ref, last_frame_image: last });
  assert.equal(frames.first_frame_image, ref);
  assert.equal(frames.last_frame_image, last);
  assert.throws(() => prepare('pixverse-v6', 'first-last-frame-to-video', { first_frame_image: ref }), /конечный кадр/);
  assert.throws(() => prepare('pixverse-v6', 'image-to-video', { image_urls: [ref, last] }), /Слишком много/);
  assert.equal(prepare('pixverse-v6', 'video-extension', { extend_from_task_id: 'own-task' }).extend_from_task_id, 'own-task');
  assert.throws(() => prepare('pixverse-v6', 'reference-to-video', { image_urls: [ref] }), /референсам/);
});

test('HappyHorse and MiniMax image mode uses the first-frame field instead of reference mode', () => {
  for (const id of ['happyhorse-1.1', 'MiniMax-H3']) {
    const image = prepare(id, 'image-to-video', { image_urls: [ref] });
    assert.equal(image.first_frame_image, ref);
    assert.equal(image.image_urls, undefined);
    const reference = prepare(id, 'reference-to-video', { image_urls: [ref] });
    assert.ok(reference.image_urls);
    assert.equal(reference.first_frame_image, undefined);
  }
  assert.throws(() => prepare('MiniMax-H3', 'image-to-video', { image_with_roles: [{ url: ref, role: 'reference_image' }] }), /несовместим/);
  const roles = prepare('MiniMax-H3', 'reference-to-video', { image_with_roles: [{ url: ref, role: 'reference_image' }] });
  assert.equal(roles.image_urls, ref);
});

test('project actions reject a silent mode change and missing sources on both adapters', () => {
  for (const id of ['gpt-image-2.text-to-image', 'image.gpt-image.1.5-text-to-image', 'seedream-4.5.text-to-image']) {
    const task = normalizedRequest({ modelId: id, input: { prompt: 'Draw', image_urls: [ref] } }).task;
    assert.throws(() => prepareTask(task, describeModel({ id: task.origin.modelId, category: 'image' })), /по тексту/);
    assert.throws(() => prepareKieTask(task, models.find(model => model.id === task.origin.modelId)), /по тексту/);
  }
  const task = normalizedRequest({ modelId: 'image.seedream.5-pro-layer-decomposition',
    originModelId: 'apimart:seedream-5-0-pro', input: { image_urls: [ref] } }).task;
  assert.equal(prepareTask(task, describeModel({ id: 'seedream-5-0-pro', category: 'image' })).parameters.layer_decomposition, true);
  task.parameters.layer_decomposition = false;
  assert.throws(() => prepareTask(task, describeModel({ id: 'seedream-5-0-pro', category: 'image' })), /нельзя отключить/);
});
