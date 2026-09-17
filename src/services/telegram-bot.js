const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { History } = require('../history');
const labels = { queued: 'В очереди', preparing: 'Подготовка', submitting: 'Отправка', waiting: 'Ожидание', queuing: 'В очереди Kie', generating: 'Генерация', success: 'Готово', fail: 'Ошибка', unknown: 'Нужно проверить журнал Kie', blocked: 'Заблокировано', cancelled: 'Отменено', unconfirmed: 'Пропущено без повтора' };
const button = (text, data) => ({ text, callback_data: data });
const reply = (text, rows = []) => ({ text: text.slice(0, 3900), reply_markup: { inline_keyboard: rows } });
const menu = [[button('Модели', 'models:0'), button('Мой запрос', 'draft')], [button('Очередь', 'queue'), button('История', 'history')], [button('Параметры', 'settings'), button('Подготовить запуск', 'generate')]];
function defaults(model) {
  const result = {};
  for (const field of model.fields) {
    if (field.default !== undefined) result[field.key] = field.default;
    else if (field.type === 'boolean') result[field.key] = false;
    else if (field.required && field.options?.length) result[field.key] = typeof field.options[0] === 'object' ? field.options[0].value : field.options[0];
    else if (field.required && field.type === 'number' && field.min !== undefined) result[field.key] = field.min;
  }
  return result;
}
function createTelegramBot({ service, directory, allowedUsers = [], publicAccess = true, downloadFile }) {
  const sessions = new History(path.join(directory, 'telegram-sessions.json'));
  const allModels = service.catalog().models;
  const allowed = new Set(allowedUsers.map(String));
  function accepts(update) {
    const message = update.callback_query?.message || update.message;
    const user = update.callback_query?.from || message?.from;
    return Boolean(message?.chat?.type === 'private' && String(message.chat.id) === String(user?.id)
      && (publicAccess || allowed.has(String(user?.id))));
  }
  async function session(id) {
    const saved = (await sessions.list()).find(item => item.id === id);
    const initial = allModels.find(model=>model.startupDefault) || allModels.find(model => model.kind === 'image' && model.fields.some(field => field.key === 'prompt') && !model.fields.some(field => field.type === 'files' && field.required)) || allModels[0];
    return saved || { id, modelId: initial.id, input: defaults(initial), sourceFiles: [], selectedFileField: null, confirmation: null };
  }
  const modelFor = data => service.findModel(data.modelId);
  function draftReply(data) {
    const model = modelFor(data);
    return reply(`${model.name}\n\n${data.input.prompt || 'Отправьте текст промпта.'}\n\nИсходников: ${data.sourceFiles.length}\nПараметры: ${JSON.stringify(data.input, null, 2)}\n\nСообщения и фото только меняют черновик. Платная генерация запускается после подтверждения.`, menu);
  }
  async function handle(update) {
    if (!accepts(update)) return null;
    const message = update.callback_query?.message || update.message;
    const chatId = String(message.chat.id);
    let data = await session(chatId);
    const text = (update.callback_query?.data || message.text || '').trim();
    const save = async changes => { data = await sessions.update(chatId, { ...data, ...changes }); };
    const model = modelFor(data);
    if (/^\/(start|help|menu)(@\w+)?$/.test(text)) return reply('Медиастудия\n\nВыберите модель, отправьте промпт и при необходимости фото/видео. «Подготовить запуск» покажет подтверждение.\n\n/models запрос — поиск модели\n/set поле значение — параметр (значение можно задать JSON)\n/params JSON — параметры целиком\n/clear — очистить исходники\n/new — новый черновик\n/queue — очередь задач\n/history — результаты\n\nЛичный черновик и результаты доступны в этом чате.', menu);
    if (/^(\/models|models:)/.test(text)) {
      const page = text.startsWith('models:') ? Number(text.split(':')[1]) : 0;
      const query = text.startsWith('/models') ? text.slice(7).trim().toLowerCase() : '';
      const filtered = allModels.filter(item => !query || `${item.name} ${item.id}`.toLowerCase().includes(query));
      const start = Number.isInteger(page) && page >= 0 ? page * 8 : 0;
      const rows = filtered.slice(start, start + 8).map(item => [button(`${item.kind === 'video' ? 'Видео' : 'Фото'} · ${item.name}`.slice(0, 60), `model:${allModels.indexOf(item)}`)]);
      if (!query) rows.push([...(start ? [button('←', `models:${page - 1}`)] : []), ...(start + 8 < filtered.length ? [button('→', `models:${page + 1}`)] : [])]);
      return reply(`Модели: ${filtered.length}. Для поиска: /models название`, rows.filter(row => row.length));
    }
    if (text.startsWith('model:')) {
      const index = Number(text.split(':')[1]);
      if (!Number.isInteger(index) || !allModels[index]) throw new Error('Модель не найдена');
      await save({ modelId: allModels[index].id, input: defaults(allModels[index]), sourceFiles: [], selectedFileField: null, confirmation: null });
      return draftReply(data);
    }
    if (['draft', '/draft'].includes(text)) return draftReply(data);
    if (['settings', '/settings'].includes(text)) {
      const rows = model.fields.filter(field => field.key !== 'prompt').map(field => [button(field.label || field.key, `field:${model.fields.indexOf(field)}`)]);
      return reply('Параметры модели. Для сложных полей: /set имя JSON. Отправка параметров не запускает генерацию.', rows.slice(0, 30));
    }
    if (text.startsWith('field:')) {
      const index = Number(text.split(':')[1]); const field = model.fields[index];
      if (!field) throw new Error('Поле не найдено');
      if (field.type === 'files') { await save({ selectedFileField: field.key }); return reply(`Следующий файл попадёт в «${field.label}». Отправьте фото, видео или документ с медиа.`); }
      const options = field.type === 'boolean' ? [true, false] : field.options || [];
      if (options.length) return reply(field.label || field.key, options.slice(0, 40).map((value, option) => [button(String(typeof value === 'object' ? value.label || value.value : value), `value:${index}:${option}`)]));
      return reply(`${field.label || field.key}\n/set ${field.key} значение\nДля объекта/списка используйте JSON.`);
    }
    if (text.startsWith('value:')) {
      const [, index, option] = text.split(':').map((value, i) => i ? Number(value) : value);
      const field = model.fields[index]; const values = field?.type === 'boolean' ? [true, false] : field?.options;
      if (!values || values[option] === undefined) throw new Error('Значение не найдено');
      const value = values[option];
      await save({ input: { ...data.input, [field.key]: typeof value === 'object' ? value.value : value }, confirmation: null });
      return draftReply(data);
    }
    if (text.startsWith('/set ')) {
      const match = /^\/set\s+(\S+)\s+([\s\S]+)$/.exec(text);
      if (!match || !model.fields.some(field => field.key === match[1]) || ['__proto__', 'constructor', 'prototype'].includes(match[1])) throw new Error('Используйте /set имя_поля значение');
      let value; try { value = JSON.parse(match[2]); } catch { value = match[2]; }
      await save({ input: { ...data.input, [match[1]]: value }, confirmation: null }); return draftReply(data);
    }
    if (text.startsWith('/params ')) {
      let input; try { input = JSON.parse(text.slice(8)); } catch { throw new Error('Параметры должны быть JSON-объектом'); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Ожидается JSON-объект');
      await save({ input, confirmation: null }); return draftReply(data);
    }
    if (text === '/new') { await save({ input: defaults(model), sourceFiles: [], confirmation: null }); return draftReply(data); }
    if (text === '/clear') {
      const input = { ...data.input }; for (const field of model.fields.filter(item => item.type === 'files')) delete input[field.key];
      await save({ input, sourceFiles: [], confirmation: null }); return draftReply(data);
    }
    if (text === 'generate' || text === '/generate') {
      if (!service.configured()) return reply('Генерация ещё не подключена на сервере. Черновик сохранён.', menu);
      service.validate(model, data.input);
      const confirmation = { token: randomUUID(), request: { modelId: model.id, input: data.input, sourceFiles: data.sourceFiles } };
      await save({ confirmation });
      return reply(`Запустить «${model.name}»?\n\n${String(data.input.prompt || '').slice(0, 1200)}\n\nИсходников: ${data.sourceFiles.length}. Генерация расходует кредиты серверного аккаунта.`, [[button('Подтвердить запуск', `go:${confirmation.token}`)], [button('Назад', 'draft')]]);
    }
    if (text.startsWith('go:')) {
      const token = text.slice(3);
      if (data.confirmation?.token !== token) throw new Error('Подтверждение устарело. Подготовьте запуск заново.');
      const task = await service.createTask({ ...data.confirmation.request, requestId: `telegram:${chatId}:${token}` });
      await service.history.update(task.id, { telegramChatId: chatId });
      service.queue.start();
      return reply(`Задача добавлена: ${task.modelName}\n${task.id}\nО готовности сообщу здесь.`, menu);
    }
    const operator = allowed.has(chatId);
    const visibleTasks = async () => (await service.listHistory()).filter(item => operator || item.telegramChatId === chatId);
    if (['queue', '/queue'].includes(text)) {
      const tasks = (await visibleTasks()).filter(item => !item.queueHidden && !['success', 'fail', 'cancelled'].includes(item.state));
      const rows = operator ? [[button(service.queue.paused ? 'Продолжить' : 'Пауза', service.queue.paused ? 'resume' : 'pause')]] : [];
      for (const task of tasks.filter(item => item.state === 'queued').slice(0, 5)) rows.push([button(`Убрать ${task.modelName}`.slice(0, 50), `cancel:${task.id}`)]);
      return reply(`${service.queue.paused ? 'Очередь на паузе' : 'Очередь работает'}\n${tasks.slice(0, 10).map(item => `${labels[item.state] || item.state} · ${item.modelName}`).join('\n') || 'Задач нет'}`, rows);
    }
    if (text === 'pause' || text === 'resume') { if (!operator) return reply('Управление общей очередью доступно только оператору.', menu); if (text === 'pause') service.queue.pause(); else service.queue.start(); return reply('Состояние очереди обновлено.', menu); }
    if (text.startsWith('cancel:')) { const id = text.slice(7); if (!(await visibleTasks()).some(item => item.id === id)) return reply('Задача недоступна.', menu); await service.queue.cancel(id); return reply('Ожидающая задача отменена.', menu); }
    if (['history', '/history'].includes(text)) {
      const tasks = (await visibleTasks()).slice(0, 8);
      return reply(tasks.map(item => `${labels[item.state] || item.state} · ${item.modelName}\n${service.resultUrls(item).join('\n')}`).join('\n\n') || 'История пока пуста.', menu);
    }
    const attachment = message.photo?.at(-1) || message.video || message.document;
    if (attachment) {
      const fields = model.fields.filter(field => field.type === 'files');
      const field = fields.find(item => item.key === data.selectedFileField) || fields[0];
      if (!field) throw new Error('У этой модели нет простого поля для файла. Выберите другую модель или задайте вложенные параметры через /params.');
      const kind = message.photo ? 'image/jpeg' : message.video ? 'video/mp4' : attachment.mime_type;
      if (!/^(image|video|audio)\//.test(kind || '')) throw new Error('Отправьте медиафайл');
      if (field.accept && !field.accept.split(',').some(type => kind === type.trim() || (type.trim().endsWith('/*') && kind.startsWith(type.trim().slice(0, -1))))) throw new Error('Тип файла не подходит выбранному полю');
      const current = field.scalar ? [] : [].concat(data.input[field.key] || []);
      if (current.length >= (field.maxFiles || 1)) throw new Error('Достигнут лимит исходников. Используйте /clear.');
      const limit = Math.min(20 * 1024 * 1024, (field.maxSizeMb || 20) * 1024 * 1024);
      if (attachment.file_size > limit) throw new Error('Файл слишком большой для бота. Используйте веб-версию.');
      const bytes = await downloadFile(attachment.file_id, limit);
      const source = await service.saveSource({ name: attachment.file_name || `source.${kind.split('/')[1]}`, type: kind, bytes });
      const sourceFiles = data.sourceFiles.filter(item => !field.scalar || item.ref !== data.input[field.key]);
      if (!sourceFiles.some(item => item.ref === source.ref)) sourceFiles.push(source);
      const input = { ...data.input, [field.key]: field.scalar ? source.ref : [...current, source.ref] };
      if (message.caption) input.prompt = message.caption;
      await save({ input, sourceFiles, confirmation: null }); return draftReply(data);
    }
    if (text.startsWith('/')) return reply('Неизвестная команда. /help — список команд.', menu);
    if (text && !update.callback_query) { await save({ input: { ...data.input, prompt: text }, confirmation: null }); return draftReply(data); }
    return reply('Кнопка устарела. Откройте /menu.', menu);
  }
  return { handle, accepts, sessions };
}
module.exports = { createTelegramBot, defaults };
