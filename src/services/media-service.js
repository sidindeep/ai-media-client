const trace = require('../generation-log');
const path = require('node:path');
const fs = require('node:fs/promises');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const { History } = require('../history');
const { Assets } = require('../assets');
const { TaskQueue } = require('../task-queue');
const { PromptTemplates } = require('../prompt-templates');
const { GenerationPresets } = require('../generation-presets');
const { models, providers } = require('../catalog');
const { buildRequest } = require('../adapters');
const costs = require('../costs');
const { download } = require('../downloads');
const Ajv = require('ajv');

async function createMediaService({ directory, provider, rubPerCredit = 0.51, downloadImpl = download, interval = 4000, stores, pricing, tariffFetcher }) {
  if (!stores) trace.configure(path.join(directory, 'logs'));
  const history = stores?.history || new History(path.join(directory, 'history.json'));
  const preferences = stores?.preferences || new History(path.join(directory, 'preferences.json'));
  const drafts = stores?.drafts || new History(path.join(directory, 'drafts.json'));
  const sourceMetadata = stores?.sources || new History(path.join(directory, 'source-metadata.json'));
  const assets = new Assets(path.join(directory, 'sources'));
  const templates = new PromptTemplates(path.join(directory, 'templates.json'), stores?.templates);
  const tariffs = new (require('../tariffs').Tariffs)(preferences, tariffFetcher || fetch);
  const { quoteKie } = require('../billing/kie-pricing');
  const events = new EventEmitter();
  const ajv = new Ajv({ strict: false, validateFormats: false });
  const pendingSaves = new Map();
  const providerDiagnostics = [];
  const diagnosticMessage = error => error instanceof Error ? error.message : String(error || 'Неизвестная ошибка');
  const addProviderDiagnostic = (step, status, message, durationMs = 0) => {
    const entry = { time: new Date().toISOString(), step, status, message, durationMs };
    providerDiagnostics.push(entry);
    if (providerDiagnostics.length > 50) providerDiagnostics.splice(0, providerDiagnostics.length - 50);
    return entry;
  };
  let enqueueChain = Promise.resolve();
  const findModel = id => {
    const requested = String(id || '');
    const apiModel = requested.replace(/^(?:kie|media):/, '');
    const model = models.find(item => item.providerId === provider.id
      && (item.id === requested || item.apiModel === requested || item.apiModel === apiModel));
    if (!model || model.providerId !== provider.id) throw new Error('Модель не найдена');
    return model;
  };
  const presets = new GenerationPresets(stores?.presets || new History(path.join(directory, 'presets.json')), findModel);
  const preference = async (id, fallback) => (await preferences.list()).find(item => item.id === id) || fallback;
  const costSettings = () => preference('cost-settings', { rubPerCredit });
  const storageSettings = async () => ({ directory: 'Хранилище сервиса', autoSave: (await preference('storage', {})).autoSave === true });
  function validate(model, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Некорректные параметры генерации');
    require('../duration').validate(model, input);
    if (model.inputSchema && !ajv.validate(model.inputSchema, input)) throw new Error('Проверьте параметры: ' + ajv.errorsText());
    buildRequest(model, input);
  }
  function urls(record) {
    let result;
    try { result = typeof record.resultJson === 'string' ? JSON.parse(record.resultJson) : record.resultJson; } catch { return []; }
    return (Array.isArray(result?.resultUrls) ? result.resultUrls : []).filter(value => {
      try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
    });
  }
  async function saveResults(id) {
    if (pendingSaves.has(id)) return pendingSaves.get(id);
    const operation = (async () => {
      const record = (await history.list()).find(item => item.id === id);
      if (record?.state !== 'success') throw new Error('Результат ещё не готов');
      const links = urls(record);
      if (!links.length) throw new Error('Нет ссылок на результат');
      const localFiles = [...(record.localFiles || [])];
      try {
        for (const url of links) {
          if (localFiles.some(file => file.url === url) && await fs.stat(localFiles.find(file => file.url === url).path).then(s => s.isFile()).catch(() => false)) continue;
          const file = await trace.run(record, () => trace.step('result.save', {url}, () => downloadImpl(url, path.join(directory, 'results'))));
          const index = localFiles.findIndex(item => item.url === url);
          if (index >= 0) localFiles[index] = file; else localFiles.push(file);
          await history.update(id, { localFiles, downloadError: null });
        }
        return localFiles.map((_file, index) => ({ url: `/api/results/${encodeURIComponent(id)}/${index}?download=1` }));
      } catch { await history.update(id, { downloadError: 'Не удалось сохранить результат. Повторите скачивание.' }); throw new Error('Не удалось сохранить результат'); }
    })();
    pendingSaves.set(id, operation);
    try { return await operation; } finally { pendingSaves.delete(id); events.emit('changed'); }
  }
  const settings = await preference('queue', { concurrency: 3 });
  const queue = new TaskQueue({
    store: history, concurrency: settings.concurrency, interval, notify: () => events.emit('changed'),
    prepare: async record => {
      if (!provider.isConfigured()) throw new Error('Генерация ещё не подключена на сервере');
      const input = await assets.resolve(record.input, record.sourceFiles || [], file => provider.upload(file));
      validate(findModel(record.modelId), input); return input;
    },
    create: (record, input) => provider.create(findModel(record.modelId), input),
    poll: record => provider.poll(findModel(record.modelId), record.taskId),
    complete: async record => {
      if ((await storageSettings()).autoSave) await saveResults(record.id).catch(() => {});
      events.emit('complete', record);
    }
  });
  await queue.recover();
  async function listHistory() {
    return Promise.all((await history.list()).map(async record => {
      const localFiles = await Promise.all((record.localFiles || []).map(async (file, index) => ({
        size: file.size, savedAt: file.savedAt, url: file.url, name: path.basename(file.path),
        previewUrl: `/api/results/${encodeURIComponent(record.id)}/${index}`,
        exists: await fs.stat(file.path).then(s => s.isFile()).catch(() => false)
      })));
      return { ...record, resultJson: JSON.stringify({ resultUrls: urls(record) }), localFiles };
    }));
  }
  const service = {
    events, queue, history, preferences, templates, presets, findModel, validate, costSettings, storageSettings, saveResults, listHistory, resultUrls: urls,
    catalog: () => ({ providers: providers.filter(item => item.id === provider.id).map(({ id, name }) => ({ id, name })), models: models.filter(item => item.providerId === provider.id) }),
    configured: () => provider.isConfigured(),
    async nativeQuote(modelId, input = {}) {
      const started = Date.now();
      try {
        const model = findModel(modelId);
        if (pricing) {
          try {
            const quote = pricing.quote(model.id, input);
            addProviderDiagnostic('quote', 'ok', `Цена ${model.name}: ${quote.credits} кредитов`, Date.now() - started);
            return quote;
          }
          catch (error) { if (!/не опубликована/i.test(error.message)) throw error; }
        }
        const quote = quoteKie(model, input, await tariffs.get());
        addProviderDiagnostic('quote', 'ok', `Цена ${model.name}: ${quote.credits} кредитов`, Date.now() - started);
        return quote;
      } catch (error) {
        addProviderDiagnostic('quote', 'error', diagnosticMessage(error), Date.now() - started);
        trace.write('pricing.quote.error', { modelId, error });
        const message = error instanceof Error ? error.message : 'неизвестная ошибка';
        if (/^(?:Цена|Некоррект|Для расчёта)/.test(message)) throw error;
        throw new Error(`Цена Kie временно недоступна: ${message}`);
      }
    },
    async diagnoseProvider(modelId, input = {}) {
      const checkedAt = new Date().toISOString();
      const checks = [];
      const add = (step, status, message, started = Date.now()) => {
        const entry = addProviderDiagnostic(step, status, message, Math.max(0, Date.now() - started));
        checks.push(entry);
      };
      const configured = provider.isConfigured();
      add('configuration', configured ? 'ok' : 'error', configured ? 'Серверный KIE_API_KEY загружен' : 'Серверный KIE_API_KEY отсутствует');
      if (configured) {
        const started = Date.now();
        try { await provider.balance(); add('authorization', 'ok', 'Kie принял ключ; запрос баланса выполнен', started); }
        catch (error) { add('authorization', 'error', diagnosticMessage(error), started); }
      }
      let tariffData;
      {
        const started = Date.now();
        try {
          tariffData = await tariffs.get(true);
          if (!Array.isArray(tariffData.rows) || !tariffData.rows.length) throw new Error(tariffData.error || 'Тарифный каталог пуст');
          add('tariffs', 'ok', `Получено тарифных строк: ${tariffData.rows.length}`, started);
        } catch (error) { add('tariffs', 'error', diagnosticMessage(error), started); }
      }
      let model = null, quote = null;
      {
        const started = Date.now();
        try {
          model = findModel(modelId);
          if (!tariffData) throw new Error('Тарифный каталог недоступен');
          quote = quoteKie(model, input, tariffData);
          add('model-price', 'ok', `${model.name}: ${quote.credits} кредитов`, started);
        } catch (error) { add('model-price', 'error', diagnosticMessage(error), started); }
      }
      return {
        ok: checks.every(item => item.status === 'ok'), configured, checkedAt,
        provider: 'Kie.ai', model: model ? { id: model.id, name: model.name } : { id: String(modelId || ''), name: '' }, quote,
        mechanism: {
          credentials: 'Серверная переменная KIE_API_KEY; значение не передаётся в браузер',
          authorization: 'GET https://api.kie.ai/api/v1/chat/credit',
          tariffs: 'POST https://api.kie.ai/client/v1/model-pricing/page',
          generation: 'Сервер создаёт задачу Kie и опрашивает её статус; тест генерацию не запускает',
        },
        checks, recentLogs: providerDiagnostics.slice(-25),
      };
    },
    async saveSource(file) {
      const saved = await assets.save(file);
      await sourceMetadata.update(assets.id(saved.ref), { ...saved, chatId: file.chatId || null, projectId: file.projectId || null });
      return saved;
    },
    async sourceFile(id) {
      if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Исходник не найден');
      const metadata = (await sourceMetadata.list()).find(item => item.id === id);
      if (!metadata) throw new Error('Исходник не найден');
      return { path: path.join(assets.directory, id), type: metadata.type };
    },
    async resultFile(id, index) {
      const record = (await history.list()).find(item => item.id === id);
      if (!Number.isInteger(index) || index < 0 || !record?.localFiles?.[index]) throw new Error('Файл не найден');
      const file = record.localFiles[index];
      const relative = path.relative(path.join(directory, 'results'), file.path);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Файл вне хранилища результатов');
      return file;
    },
    async createTask(request) {
      const operation = enqueueChain.then(()=>trace.request(()=>trace.step('generation.request',{request},async () => {
        if (!provider.isConfigured()) throw new Error('Генерация ещё не подключена на сервере');
        const model = findModel(request?.modelId);
        validate(model, request.input);
        if (!Array.isArray(request.sourceFiles || []) || (request.sourceFiles || []).length > 100) throw new Error('Некорректный список исходников');
        if (request.requestId && (typeof request.requestId !== 'string' || request.requestId.length > 150)) throw new Error('Некорректный идентификатор запроса');
        const binding = { projectId: request.projectId || null, chatId: request.chatId || null };
        const digest = createHash('sha256').update(JSON.stringify({ modelId: model.id, input: request.input, sourceFiles: request.sourceFiles || [], ...binding })).digest('hex');
        if (request.requestId) {
          const existing = (await history.list()).find(row => row.requestId === request.requestId);
          if (existing) {
            if (existing.requestDigest !== digest) throw new Error('Этот запрос уже сохранён с другими параметрами');
            return existing;
          }
        }
        const price = await costSettings();
        const cachedTariffs=(await preference('kie-tariffs',{})).data;
        const record = await queue.enqueue({
          modelId: model.id, providerId: model.providerId, providerName: providers.find(item => item.id === model.providerId)?.name || model.providerId, model: model.apiModel,
          modelName: model.name, kind: model.kind, input: request.input,
          sourceFiles: request.sourceFiles || [], workspace: [1, 2, 3, 4, 5].includes(request.workspace) ? request.workspace : 1,
          ...binding,
          requestId: request.requestId || null, requestDigest: digest,
          ...(pricing ? { nativeQuote: await service.nativeQuote(model.id, request.input) } : {}),
          rubPerCredit: price.rubPerCredit, estimate: costs.quote(model, request.input, cachedTariffs)
        });
        return record;
      })));
      enqueueChain = operation.catch(() => {}); return operation;
    },
    async dispatch(method, args = []) {
      switch (method) {
        case 'getCatalog': return service.catalog();
        case 'nativeQuote': return service.nativeQuote(args[0]?.modelId, args[0]?.input);
        case 'diagnoseProvider': return service.diagnoseProvider(args[0]?.modelId, args[0]?.input);
        case 'keyStatus': return service.configured();
        case 'getHistory': return listHistory();
        case 'queueStatus': return { paused: queue.paused, error: queue.error, concurrency: queue.concurrency };
        case 'startQueue': queue.start(); return true;
        case 'pauseQueue': queue.pause(); return true;
        case 'setConcurrency': queue.setConcurrency(args[0]); await preferences.update('queue', { concurrency: args[0] }); return args[0];
        case 'cancelQueued': return queue.cancel(args[0]);
        case 'removeQueued': return queue.remove(args[0]);
        case 'clearQueue': return queue.clear();
        case 'acknowledgeTask': return queue.acknowledge(args[0]);
        case 'createTask': return service.createTask(args[0]);
        case 'getTask': {
          const record = (await listHistory()).find(item => item.providerId === args[0] && item.taskId === args[1]);
          if (!record) throw new Error('Задача не найдена');
          return { ...record, resultJson: JSON.stringify({ resultUrls: urls(record) }) };
        }
        case 'getFavoriteModels': return (await preference('favorites', {})).ids || [];
        case 'setFavoriteModels': {
          if (!Array.isArray(args[0]) || args[0].length > 500 || args[0].some(id => !models.some(m => m.id === id))) throw new Error('Некорректное избранное');
          const ids = [...new Set(args[0])]; await preferences.update('favorites', { ids }); return ids;
        }
        case 'listTemplates': return templates.list();
        case 'saveTemplate': return templates.save(args[0]);
        case 'removeTemplate': return templates.remove(args[0]);
        case 'listGenerationPresets': return presets.list();
        case 'saveGenerationPreset': return presets.save(args[0]);
        case 'removeGenerationPreset': return presets.remove(args[0]);
        case 'loadDrafts': return (await drafts.list()).find(item => item.id === (args[0]?.chatId ? `chat:${args[0].chatId}` : 'workspace'))?.data || null;
        case 'saveDrafts': {
          const data = args[0];
          if (data?.version !== 1 || !Array.isArray(data.tabs) || data.tabs.length < 1 || data.tabs.length > 5) throw new Error('Некорректный черновик');
          const draftId = args[1]?.chatId || args[0]?.chatId;
          await drafts.update(draftId ? `chat:${draftId}` : 'workspace', { data }); return true;
        }
        case 'costSettings': return costSettings();
        case 'setCreditRate': {
          if (typeof args[0] !== 'number' || !Number.isFinite(args[0]) || args[0] <= 0 || args[0] > 100000) throw new Error('Некорректная цена');
          await preferences.update('cost-settings', { rubPerCredit: args[0] }); return costSettings();
        }
        case 'storageSettings': return storageSettings();
        case 'setAutoSave': if (typeof args[0] !== 'boolean') throw new Error('Некорректная настройка'); await preferences.update('storage', { autoSave: args[0] }); return storageSettings();
        case 'saveResults': return saveResults(args[0]);
        case 'getTariffDescriptions': return require('../kie-price-descriptions.json');
        case 'getTariffs': return args[0] === true ? tariffs.get(true) : { ...((await preference('kie-tariffs', {})).data || { rows: [] }), stale: true };
        case 'getBalance': {
          const balance = costs.amount(await provider.balance());
          if (balance === null) throw new Error('Некорректный баланс');
          return { balance, audit: null };
        }
        default: throw new Error('Метод сервиса не поддерживается');
      }
    },
    async close() {
      queue.close();
      while (queue.running) await new Promise(resolve => setTimeout(resolve, 20));
      await Promise.allSettled([...pendingSaves.values(), history.queue, preferences.queue, drafts.queue, sourceMetadata.queue]);
    }
  };
  return service;
}
module.exports = { createMediaService };
