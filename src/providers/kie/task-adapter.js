const Ajv = require('ajv');
const { rawTask, semanticKey: commonKey, contentRefs } = require('../../media/generation-task');
const { buildRequest } = require('../../adapters');
const { validateTaskAction } = require('../../media/task-actions');
const { motionControlMode } = require('../../media/kling-motion-control');
const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });

function semanticKey(key, modelId) {
  if (/^kie:qwen3\//.test(modelId) && key === 'image_size') return 'aspect_ratio';
  if (modelId.startsWith('kie:pixverse-v6/') && key === 'quality') return 'resolution';
  if (modelId.includes('layer-decomposition') && key === 'size') return 'size';
  return commonKey(key);
}
function readTask(raw) {
  const task = rawTask(raw, semanticKey);
  if (raw.modelId.includes('layer-decomposition')) task.parameters.layer_decomposition = true;
  return task;
}

function assetRefs(value) {
  if (typeof value === 'string') return /^(?:content:|https?:\/\/)/.test(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(assetRefs);
  if (value && typeof value === 'object') return Object.entries(value).filter(([key]) => key !== 'prompt').flatMap(([, item]) => assetRefs(item));
  return [];
}
function preparedRequest(task, model, input) {
  const wire = buildRequest(model, input);
  const refs = new Set(assetRefs(wire));
  if (assetRefs(input).some(ref => !refs.has(ref))) throw new Error('Маршрут Kie не сохраняет все исходники задачи');
  return { modelId: model.id, input, sourceFiles: task.sourceFiles };
}
function prepareTask(task, model) {
  validateTaskAction(task);
  if (task.origin.modelId === model.id) return preparedRequest(task, model, structuredClone(task.origin.input));
  if (task.parameters.source_task_id || task.parameters.task_id)
    throw new Error('Задачу другого провайдера нельзя использовать как исходник Kie');
  const input = { prompt: task.prompt };
  const properties = model.inputSchema?.properties || {};
  for (const [key, value] of Object.entries(task.parameters)) {
    const candidates = Object.keys(properties).filter(field => semanticKey(field, model.id) === key);
    if (candidates.length !== 1) {
      if (key === 'count' && value === 1) continue;
      if (key === 'layer_decomposition' && value === true && model.id.includes('layer-decomposition')) continue;
      throw new Error(`Параметр ${key} не поддерживается Kie`);
    }
    const target = candidates[0], schema = properties[target];
    let mapped = target === 'mode' ? motionControlMode(model.id, value) : value;
    if (schema.type === 'array' && !Array.isArray(mapped)) mapped = [mapped];
    if (schema.type === 'string' && Array.isArray(mapped) && mapped.length === 1) mapped = mapped[0];
    if (schema.enum) {
      mapped = schema.enum.find(option => String(option).toLowerCase() === String(mapped).toLowerCase());
      if (mapped === undefined) throw new Error(`Значение ${key} не поддерживается Kie`);
    }
    input[target] = mapped;
  }
  const refs = new Set(contentRefs(input));
  if (task.sourceFiles.some(file => !refs.has(file.ref))) throw new Error('Не все исходники удалось перенести в Kie');
  if (model.inputSchema && !ajv.validate(model.inputSchema, input)) throw new Error('Проверьте параметры Kie: ' + ajv.errorsText());
  return preparedRequest(task, model, input);
}
function prepareRouteTask(task, models) {
  let failure;
  for (const model of models) {
    try { return prepareTask(task, model); }
    catch (error) { failure ||= error; }
  }
  throw failure || new Error('Модель Kie недоступна');
}
module.exports = { readTask, prepareTask, prepareRouteTask };
