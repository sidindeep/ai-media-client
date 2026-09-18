const catalog = require('../../config/codex-models.json');
function invalid(message) { return Object.assign(new Error(message), { status: 400 }); }
function validateCodexRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Некорректный запрос Codex');
  if (Object.keys(input).some(key => !['prompt', 'model', 'effort', 'speed', 'requestId', 'kind'].includes(key))) throw invalid('Недопустимые параметры Codex');
  if (input.kind !== undefined && !['text', 'image'].includes(input.kind)) throw invalid('Некорректный тип результата');
  const model = catalog.models.find(item => item.id === input.model);
  if (!model || !model.efforts.includes(input.effort)) throw invalid('Модель или уровень рассуждения недоступны');
  if (!['standard', 'fast'].includes(input.speed)) throw invalid('Некорректная скорость');
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 20000) throw invalid('Укажите текст до 20 000 символов');
  if (typeof input.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.requestId)) throw invalid('Некорректный ID запроса');
  return { prompt: input.prompt.trim(), model: model.id, effort: input.effort, speed: input.speed, requestId: input.requestId, ...(input.kind ? { kind: input.kind } : {}) };
}
function codexArguments(request) {
  return ['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
    '--sandbox', 'read-only', '--color', 'never', '--model', request.model,
    ...['shell_tool', 'unified_exec', 'apps', 'browser_use', 'browser_use_external', 'computer_use', 'view_image', 'hooks', 'skill_search', 'workspace_dependencies', 'in_app_browser', 'in_app_chat', 'remote_plugin'].flatMap(feature => ['--disable', feature]),
    ...['code_mode', 'code_mode_host', 'image_generation'].flatMap(feature => [request.kind === 'image' ? '--enable' : '--disable', feature]),
    '--json',
    '-c', 'web_search="disabled"',
    '-c', `model_reasoning_effort="${request.effort}"`,
    ...(request.speed === 'fast' ? ['-c', 'service_tier="fast"'] : []),
    '-c', `features.fast_mode=${request.speed === 'fast'}`, '-'];
}
module.exports = { validateCodexRequest, codexArguments };
