const { rawTask, semanticKey, contentRefs } = require('../../media/generation-task');
const { validateTaskAction } = require('../../media/task-actions');
const { describeModel } = require('./catalog');
const { motionControlMode } = require('../../media/kling-motion-control');

function readTask(raw) {
  const model = describeModel({ id: raw.modelId.replace(/^apimart:/, '') });
  const profile = model?.taskActions?.[raw.action];
  const task = rawTask(raw, key => {
    if (raw.action === 'layer-decomposition' && key === 'size') return 'size';
    return Object.entries(profile?.fields || {}).find(([, field]) => field === key)?.[0] || semanticKey(key);
  });
  if (profile?.frames && task.parameters.source_images) {
    const frames = task.parameters.source_images;
    if (!Array.isArray(frames) || frames.length > 2) throw new Error('Режим кадров принимает одно или два изображения');
    [task.parameters.first_frame, task.parameters.last_frame] = frames;
    delete task.parameters.source_images;
  }
  for (const [key, value] of Object.entries(profile?.parameters || {}))
    if (task.parameters[key] === value) delete task.parameters[key];
  if (raw.action && raw.action !== 'auto' && task.parameters.image_with_roles) {
    const roles = { first: 'first_frame', first_frame: 'first_frame', last: 'last_frame', last_frame: 'last_frame',
      reference: 'reference_images', reference_image: 'reference_images' };
    const images = task.parameters.image_with_roles;
    if (!Array.isArray(images)) throw new Error('Изображения с ролями должны быть массивом');
    for (const item of images) {
      const key = roles[item?.role];
      if (!key || typeof item.url !== 'string' || Object.keys(item).some(key => !['url', 'role'].includes(key)))
        throw new Error('Неподдерживаемая роль или параметры изображения');
      if (key === 'reference_images') task.parameters[key] = [...(task.parameters[key] || []), item.url];
      else {
        if (task.parameters[key]) throw new Error('Конфликт исходников кадра');
        task.parameters[key] = item.url;
      }
    }
    delete task.parameters.image_with_roles;
  }
  return task;
}

const defaults = { nsfw_checker: false, background: 'opaque', output_format: 'png',
  enableTranslation: false, watermark: '', count: 1 };
function prepareTask(task, model) {
  const profile = model.taskActions?.[task.action];
  if (model.taskActions && task.action !== 'auto' && !profile) throw new Error('APIMart не поддерживает выбранный режим этой модели');
  validateTaskAction(task);
  const native = task.origin.modelId === `apimart:${model.id}`;
  if (!native && (task.parameters.source_task_id || task.parameters.task_id))
    throw new Error('Задачу другого провайдера нельзя использовать как исходник APIMart');
  if (native && task.action === 'auto') {
    const refs = new Set(contentRefs(task.origin.input));
    if (task.sourceFiles.some(file => !refs.has(file.ref))) throw new Error('Не все исходники удалось перенести в APIMart');
    return { model: model.id, prompt: task.prompt,
      parameters: Object.fromEntries(Object.entries(task.origin.input).filter(([key]) => key !== 'prompt')) };
  }
  const parameters = { ...task.parameters };
  if (task.action === 'layer-decomposition') parameters.layer_decomposition = true;
  if (profile?.requireLast && !parameters.last_frame) throw new Error('Для перехода нужен конечный кадр');
  if (profile?.frames) {
    parameters.source_images = [parameters.first_frame, parameters.last_frame].filter(Boolean);
    delete parameters.first_frame; delete parameters.last_frame;
  }
  if (model.promptRequired && !parameters.layer_decomposition && !task.prompt.trim())
    throw new Error('Для APIMart нужен текстовый запрос');
  const fields = model.fields || [];
  const result = {};
  for (const [key, value] of Object.entries(parameters)) {
    if (value == null) continue;
    let candidates = fields.filter(field => semanticKey(field.key, `apimart:${model.id}`) === key);
    if (profile?.fields?.[key]) candidates = fields.filter(field => field.key === profile.fields[key]);
    // Layer decomposition uses the provider's literal size setting.
    if (key === 'size') candidates = fields.filter(field => field.key === 'size');
    let field = candidates.length === 1 ? candidates[0] : null;
    let role;
    if (!field && ['reference_images', 'first_frame', 'last_frame'].includes(key)) {
      if (key === 'reference_images') field = fields.find(item => semanticKey(item.key) === 'source_images'
        && item.type === 'files' && (item.uploadToApimart || item.acceptsBase64));
      if (!field) {
        field = fields.find(item => item.type === 'json' && item.nestedImageKey);
        role = key === 'reference_images' ? 'reference_image' : key;
      }
    }
    if (!field) {
      if (Object.hasOwn(defaults, key) && defaults[key] === value) continue;
      throw new Error(`Параметр ${key} не поддерживается APIMart`);
    }
    let mapped = field.key === 'mode' ? motionControlMode(`apimart:${model.id}`, value) : value;
    if (role || field.type === 'files') {
      if (!role && !field.uploadToApimart && !field.acceptsBase64)
        throw new Error(`Перенос исходников ${key} в APIMart не поддерживается`);
      const values = Array.isArray(value) ? value : [value];
      if (values.some(ref => typeof ref !== 'string' || !/^content:[a-f0-9-]{36}$/.test(ref) && !(native && /^https?:\/\//.test(ref))))
        throw new Error('Для APIMart загрузите исходники в хранилище сервиса');
      if (field.maxFiles && values.length > field.maxFiles || field.scalar && values.length !== 1)
        throw new Error(`Слишком много исходников для ${field.key}`);
      mapped = role ? [...(result[field.key] || []), ...values.map(ref => ({ [field.nestedImageKey]: ref, role }))]
        : field.scalar ? values[0] : values;
    } else if (contentRefs(value).length && !field.nestedImageKey) {
      throw new Error(`Перенос исходников ${key} в APIMart не поддерживается`);
    }
    const option = field.options?.find(item => String(item).toLowerCase() === String(mapped).toLowerCase());
    if (field.options?.length && option === undefined) throw new Error(`Значение ${key} не поддерживается APIMart`);
    if (result[field.key] != null && !role) throw new Error(`Конфликт исходников для ${field.key}`);
    result[field.key] = option ?? mapped;
  }
  for (const [key, value] of Object.entries(profile?.parameters || {})) {
    if (result[key] != null && result[key] !== value) throw new Error(`Параметр ${key} противоречит выбранному режиму`);
    result[key] = value;
  }
  if (profile?.forbidden?.some(key => result[key] != null)) throw new Error('Параметры запроса противоречат выбранному режиму');
  const refs = new Set(contentRefs(result));
  if (task.sourceFiles.some(file => !refs.has(file.ref))) throw new Error('Не все исходники удалось перенести в APIMart');
  if (fields.some(field => field.key === 'n') && result.n === undefined) result.n = 1;
  for (const field of fields) {
    if (field.required && result[field.key] == null && field.apiDefault == null && field.key !== 'prompt')
      throw new Error(`Обязательный параметр ${field.key} не передан в APIMart`);
  }
  return { model: model.id, prompt: task.prompt, parameters: result };
}
module.exports = { readTask, prepareTask };
