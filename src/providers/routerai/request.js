const catalog = require('../../../config/routerai-models.json');
function invalid(message) { return Object.assign(new Error(message), { status: 400 }); }
function validateRouterAiRequest(raw, models = catalog.models) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('Некорректный запрос RouterAI');
  if (Object.keys(raw).some(key => !['requestId', 'model', 'prompt', 'projectId', 'chatId', 'quotedAmountUnits'].includes(key))) throw invalid('Недопустимые параметры RouterAI');
  const model = models.find(item => item.id === raw.model);
  if (!model || !['text', 'image'].includes(model.kind)) throw invalid('Модель RouterAI недоступна в этом режиме');
  if (typeof raw.prompt !== 'string' || !raw.prompt.trim() || raw.prompt.length > 20000) throw invalid('Укажите текст до 20 000 символов');
  if (typeof raw.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(raw.requestId)) throw invalid('Некорректный ID запроса');
  for (const [value, label] of [[raw.projectId, 'Проект'], [raw.chatId, 'Чат']]) {
    if (value !== undefined && value !== null && (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value))) throw invalid(`${label} не найден`);
  }
  return { requestId: raw.requestId, model: model.id, kind: model.kind, endpoint: model.endpoint || (model.kind === 'image' ? 'images' : 'chat/completions'),
    outputFormat: model.outputFormat || 'raster', prompt: raw.prompt.trim(),
    ...(raw.quotedAmountUnits !== undefined ? { quotedAmountUnits: raw.quotedAmountUnits } : {}),
    ...(raw.projectId ? { projectId: raw.projectId } : {}), ...(raw.chatId ? { chatId: raw.chatId } : {}) };
}

module.exports = { validateRouterAiRequest };
