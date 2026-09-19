const catalog = require('../../config/codex-models.json');
function invalid(message) { return Object.assign(new Error(message), { status: 400 }); }
function validateCodexRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Некорректный запрос Codex');
  if (Object.keys(input).some(key => !['prompt', 'model', 'effort', 'speed', 'requestId', 'kind', 'aspectRatio', 'sourceFiles', 'images'].includes(key))) throw invalid('Недопустимые параметры Codex');
  if (input.kind !== undefined && !['text', 'image'].includes(input.kind)) throw invalid('Некорректный тип результата');
  const model = catalog.models.find(item => item.id === input.model);
  if (!model || !model.efforts.includes(input.effort)) throw invalid('Модель или уровень рассуждения недоступны');
  if (!['standard', 'fast'].includes(input.speed)) throw invalid('Некорректная скорость');
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 20000) throw invalid('Укажите текст до 20 000 символов');
  if (typeof input.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.requestId)) throw invalid('Некорректный ID запроса');
  if (input.aspectRatio !== undefined && !['auto', '1:1', '16:9', '9:16', '3:2', '2:3'].includes(input.aspectRatio)) throw invalid('Некорректное соотношение сторон');
  const sourceFiles = input.sourceFiles === undefined ? [] : input.sourceFiles;
  if (!Array.isArray(sourceFiles) || sourceFiles.length > 10 || sourceFiles.some(ref => typeof ref !== 'string' || !/^https:\/\/local-assets\.invalid\/[a-f0-9]{64}$/.test(ref))) throw invalid('Некорректные исходные изображения');
  const images = input.images === undefined ? [] : input.images;
  if (!Array.isArray(images) || images.length > 10 || images.some(item => typeof item !== 'string' || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(item))) throw invalid('Некорректные исходные изображения');
  if (images.reduce((total, item) => total + Buffer.byteLength(item, 'base64'), 0) > 90 * 1024 * 1024) throw invalid('Общий размер исходных изображений слишком большой');
  return { prompt: input.prompt.trim(), model: model.id, effort: input.effort, speed: input.speed, requestId: input.requestId,
    ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}), ...(sourceFiles.length ? { sourceFiles } : {}), ...(images.length ? { images } : {}), ...(input.kind ? { kind: input.kind } : {}) };
}
const disabledFeatures = ['shell_tool', 'unified_exec', 'apps', 'browser_use', 'browser_use_external', 'computer_use', 'view_image', 'hooks', 'skill_search', 'workspace_dependencies', 'in_app_browser', 'in_app_chat', 'remote_plugin'];
const imageFeatures = ['code_mode', 'code_mode_host', 'image_generation'];
function codexPrompt(request) {
  return (request.kind === 'image'
    ? `Generate exactly one image with the built-in image generation tool. Do not substitute text, SVG or code. Target aspect ratio: ${request.aspectRatio || 'auto'}. Treat the following as the image description:\n\n`
    : 'Act only as a text model. Do not use tools, inspect files, or run commands. Return the requested text.\n\n') + request.prompt;
}
function codexArguments(request, imagePaths = []) {
  return ['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
    '--sandbox', 'read-only', '--color', 'never', '--model', request.model,
    ...disabledFeatures.flatMap(feature => ['--disable', feature]),
    ...imageFeatures.flatMap(feature => [request.kind === 'image' ? '--enable' : '--disable', feature]),
    '--json',
    '-c', 'web_search="disabled"',
    '-c', `model_reasoning_effort="${request.effort}"`,
    ...(request.speed === 'fast' ? ['-c', 'service_tier="fast"'] : []),
    '-c', `features.fast_mode=${request.speed === 'fast'}`, ...imagePaths.flatMap(filename => ['--image', filename]), '-'];
}
module.exports = { validateCodexRequest, codexArguments, codexPrompt, disabledFeatures, imageFeatures };
