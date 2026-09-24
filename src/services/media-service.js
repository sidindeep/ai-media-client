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
const { createCreditConversion } = require('../billing/conversion');
const { normalizePricingInput } = require('../billing/normalize-request');
const { unpricedQuote } = require('../billing/quote-engine');
const { resolvePriceSources } = require('../billing/price-sources');
const { download } = require('../downloads');
const { mediaDurationSeconds } = require('../media-duration');
const Ajv = require('ajv');

async function createMediaService({ directory, provider, rubPerCredit = 0.51, downloadImpl = download, interval = 2000, stores, pricing, conversion, tariffFetcher, accountQuote, storage = null, storagePrefix = '', content = null, accountId = null }) {
  if (!stores) trace.configure(path.join(directory, 'logs'));
  const history = stores?.history || new History(path.join(directory, 'history.json'));
  const preferences = stores?.preferences || new History(path.join(directory, 'preferences.json'));
  const drafts = stores?.drafts || new History(path.join(directory, 'drafts.json'));
  const sourceMetadata = stores?.sources || new History(path.join(directory, 'source-metadata.json'));
  const assets = new Assets(path.join(directory, 'sources'), { storage, prefix: storagePrefix, content, accountId });
  const templates = new PromptTemplates(path.join(directory, 'templates.json'), stores?.templates);
  const tariffs = new (require('../tariffs').Tariffs)(preferences, tariffFetcher || fetch);
  const { quoteKie, quoteKiePublic, quoteKieDocumented } = require('../billing/kie-pricing');
  const creditConversion = conversion || createCreditConversion({ kieRubPerCredit: rubPerCredit });
  const events = new EventEmitter();
  const ajv = new Ajv({ strict: false, validateFormats: false });
  const pendingSaves = new Map();
  const providerDiagnostics = [];
  // `pricing` marks account mode, where a verified quote can be reserved.
  const nativeBilling = Boolean(pricing);
  const accountProvider = (id = 'primary') => {
    if (provider.selectAccount) return provider.selectAccount(id);
    if (id !== 'primary') throw new Error('Неизвестный аккаунт Kie');
    return provider;
  };
  const diagnosticMessage = error => error instanceof Error ? error.message : String(error || 'Неизвестная ошибка');
  const addProviderDiagnostic = (step, status, message, durationMs = 0, kieAccountId = 'primary') => {
    const entry = { time: new Date().toISOString(), step, status, message, durationMs, kieAccountId };
    providerDiagnostics.push(entry);
    if (providerDiagnostics.length > 50) providerDiagnostics.splice(0, providerDiagnostics.length - 50);
    return entry;
  };
  const enqueueChains = new Map();
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
  const storageSettings = async () => ({ directory: content ? 'Единое хранилище контента' : storage ? 'Общее S3-хранилище' : 'Хранилище сервиса', autoSave: content ? true : (await preference('storage', {})).autoSave === true });
  function validate(model, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Некорректные параметры генерации');
    require('../duration').normalize(model, input);
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
      const linkedResults = content ? await content.links(accountId, 'history', id, 'result') : [];
      try {
        for (const [linkIndex, url] of links.entries()) {
          const existing = localFiles.find(file => file.url === url);
          if (existing && (existing.assetId ? (await content?.get(accountId,existing.assetId))?.status==='ready' : existing.storageKey ? await storage?.head(existing.storageKey).then(() => true).catch(() => false) : await fs.stat(existing.path).then(s => s.isFile()).catch(() => false))) continue;
          if (content) {
            let asset = linkedResults.find(item => item.position === linkIndex);
            if (!asset) {
              asset = await content.createFromUrl(accountId, { url, name: `result-${linkIndex}`, origin: { kind: 'result', provider: record.providerId || 'media', recordId: id, position: linkIndex } });
              await content.link(accountId, 'history', id, asset.id, 'result', linkIndex);
            } else if (asset.status === 'failed') await content.retry(accountId, asset.id);
            const ready = await content.wait(accountId, asset.id);
            const file = { assetId: ready.id, name: ready.name, type: ready.type, url, size: ready.size, savedAt: new Date().toISOString() };
            const index = localFiles.findIndex(item => item.url === url);
            if (index >= 0) localFiles[index] = file; else localFiles.push(file);
            await history.update(id, { localFiles, downloadError: null, resultSavedAt: new Date().toISOString() });
            continue;
          }
          let file = await trace.run(record, () => trace.step('result.save', {url}, () => downloadImpl(url, path.join(directory, 'results'))));
          if (storage) {
            const extension = path.extname(file.path).toLowerCase();
            const type = ({ '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.mp4':'video/mp4','.webm':'video/webm','.mov':'video/quicktime' })[extension] || 'application/octet-stream';
            const storageKey = `${storagePrefix}/results/${id}/${linkIndex}${extension}`.replace(/^\/+/, '');
            const bytes = await fs.readFile(file.path);
            await storage.put(storageKey, bytes, type);
            await fs.unlink(file.path).catch(() => {});
            file = { storageKey, name: path.basename(file.path), type, url: file.url, size: file.size, savedAt: file.savedAt };
          }
          const index = localFiles.findIndex(item => item.url === url);
          if (index >= 0) localFiles[index] = file; else localFiles.push(file);
          await history.update(id, { localFiles, downloadError: null, resultSavedAt: new Date().toISOString() });
        }
        return localFiles.map((_file, index) => ({ url: `/api/results/${encodeURIComponent(id)}/${index}?download=1` }));
      } catch { await history.update(id, { downloadError: 'Не удалось сохранить результат. Повторите скачивание.' }); throw new Error('Не удалось сохранить результат'); }
    })();
    pendingSaves.set(id, operation);
    try { return await operation; } finally { pendingSaves.delete(id); events.emit('changed'); }
  }
  const settings = await preference('queue', { concurrency: 5 });
  const queue = new TaskQueue({
    store: history, concurrency: settings.concurrency, interval, notify: change => events.emit(change?.full ? 'reset' : 'changed'),
    prepare: async record => {
      const selectedProvider = accountProvider(record.kieAccountId);
      if (!selectedProvider.isConfigured()) throw new Error('Для выбранного аккаунта Kie не настроен ключ');
      const input = await assets.resolve(record.input, record.sourceFiles || [], file => selectedProvider.upload(file), record.kieAccountId || 'primary');
      validate(findModel(record.modelId), input); return input;
    },
    create: (record, input) => accountProvider(record.kieAccountId).create(findModel(record.modelId), input),
    beforeCreate: record => accountProvider(record.kieAccountId).waitForCreate?.(),
    onRateLimit: record => accountProvider(record.kieAccountId).rateLimited?.(),
    poll: record => accountProvider(record.kieAccountId).poll(findModel(record.modelId), record.taskId),
    complete: async record => {
      if (content || (await storageSettings()).autoSave) await saveResults(record.id).catch(() => {});
      events.emit('complete', record);
    }
  });
  await queue.recover();
  async function presentHistory(records) {
    return Promise.all(records.map(async record => {
      const localFiles = await Promise.all((record.localFiles || []).map(async (file, index) => {
        const asset = file.assetId ? await content?.get(accountId,file.assetId) : null;
        return {
          assetId:file.assetId,size:asset?.size??file.size,savedAt:file.savedAt,url:file.url,name:asset?.name||file.name||path.basename(file.path||file.storageKey),
          previewUrl:file.assetId?`/api/content/${file.assetId}`:`/api/results/${encodeURIComponent(record.id)}/${index}`,
          exists:file.assetId?asset?.status==='ready':file.storageKey?await storage?.head(file.storageKey).then(()=>true).catch(()=>false):await fs.stat(file.path).then(s=>s.isFile()).catch(()=>false)
        };
      }));
      return { ...record, resultJson: JSON.stringify({ resultUrls: urls(record) }), localFiles };
    }));
  }
  async function trustedSourceFiles(files = []) {
    if (!Array.isArray(files) || files.length > 100) throw new Error('Некорректный список исходников');
    const metadata = await sourceMetadata.list();
    return Promise.all(files.map(async item => {
      const id = assets.referenceId(item?.ref);
      const stored = id && metadata.find(entry => entry.id === id);
      if (!stored) throw new Error('Не найдены сведения о сохранённом исходнике');
      let durationSeconds = Number(stored.durationSeconds);
      if (String(stored.type || '').startsWith('video/') && (!Number.isFinite(durationSeconds) || durationSeconds <= 0)) {
        const bytes = await assets.readRef(item.ref).catch(error => {
          if (error.code === 'ENOENT' || error.name === 'NoSuchKey') throw new Error(`Исходник «${stored.name}» не найден. Выберите файл заново.`);
          throw error;
        });
        durationSeconds = mediaDurationSeconds(bytes, stored.type);
        if (!durationSeconds) throw new Error(`Не удалось определить длительность исходника «${stored.name}»`);
        await sourceMetadata.update(id, { durationSeconds });
      }
      return { ref: item.ref, fieldKey: item.fieldKey, type: stored.type, durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : null };
    }));
  }
  async function listHistory() { return presentHistory(await history.list()); }
  async function listHistorySince(since, before, activeIds = []) {
    return typeof history.listSince === 'function' ? presentHistory(await history.listSince(since, before, activeIds)) : listHistory();
  }
  const service = {
    events, queue, history, preferences, templates, presets, findModel, validate, costSettings, storageSettings, saveResults, listHistory, listHistorySince, resultUrls: urls,
    catalog: () => ({ providers: providers.filter(item => item.id === provider.id).map(({ id, name }) => ({ id, name })), models: models.filter(item => item.providerId === provider.id), kieAccounts: provider.listAccounts?.() || [{ id: 'primary', name: 'Kie.ai · 1', configured: provider.isConfigured() }] }),
    configured: () => provider.isConfigured(),
    async nativeQuote(modelId, input = {}, sourceFiles = [], forceRefresh = false) {
      const started = Date.now();
      const model = findModel(modelId);
      const pricingContext = { sourceFiles: await trustedSourceFiles(sourceFiles) };
      try {
        const validateQuote = raw => creditConversion.quote('kie', raw);
        let resolved = await resolvePriceSources([
          { id: 'account', quote: accountQuote && (() => accountQuote(model, input, pricingContext)) },
        ], validateQuote);
        if (!resolved.quote) {
          let tariffData = await tariffs.get(forceRefresh);
          const resolve = data => resolvePriceSources([
            { id: 'public', quote: () => quoteKiePublic(model, input, data, pricingContext) },
            { id: 'documented', quote: () => quoteKieDocumented(model, input, data) },
          ], validateQuote);
          resolved = await resolve(tariffData);
          if (!resolved.quote) {
            const error = resolved.attempts.find(item => item.source === 'public')?.error;
            // A newly published model or price variant may not be present in the
            // 24-hour account cache. Refresh the official Kie list once before
            // rejecting the paid request.
            if (forceRefresh || !/Цена (?:этой модели Kie ещё не опубликована|выбранных параметров Kie ещё не определена)/i.test(diagnosticMessage(error))) throw error || new Error('Цена Kie недоступна');
            tariffData = await tariffs.get(true);
            resolved = await resolve(tariffData);
            if (!resolved.quote) throw resolved.attempts.find(item => item.source === 'public')?.error || new Error('Цена Kie недоступна');
          }
        }
        const productQuote = { ...resolved.value, source: resolved.source };
        addProviderDiagnostic('quote', 'ok', `Цена ${model.name}: ${productQuote.credits} кредитов`, Date.now() - started);
        return productQuote;
      } catch (error) {
        addProviderDiagnostic('quote', 'error', diagnosticMessage(error), Date.now() - started);
        trace.write('pricing.quote.error', { modelId, error });
        return unpricedQuote(/ещё не опубликована/.test(diagnosticMessage(error)) ? 'tariff_not_found' : 'price_unavailable');
      }
    },
    async diagnoseProvider(modelId, input = {}, sourceFiles = [], kieAccountId = 'primary') {
      const selectedProvider = accountProvider(kieAccountId);
      const checkedAt = new Date().toISOString();
      const checks = [];
      const add = (step, status, message, started = Date.now()) => {
        const entry = addProviderDiagnostic(step, status, message, Math.max(0, Date.now() - started), kieAccountId);
        checks.push(entry);
      };
      const configured = selectedProvider.isConfigured();
      const keyName = kieAccountId === 'secondary' ? 'KIE_API_KEY_2' : 'KIE_API_KEY';
      add('configuration', configured ? 'ok' : 'error', configured ? `Серверный ${keyName} загружен` : `Серверный ${keyName} отсутствует`);
      let balance = null;
      if (configured) {
        const started = Date.now();
        try { balance = costs.amount(await selectedProvider.balance()); add('authorization', 'ok', 'Kie принял ключ; запрос баланса выполнен', started); }
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
          quote = creditConversion.quote('kie', quoteKie(model, input, tariffData, { sourceFiles: await trustedSourceFiles(sourceFiles) }));
          add('model-price', 'ok', `${model.name}: ${quote.credits} кредитов`, started);
        } catch (error) { add('model-price', 'error', diagnosticMessage(error), started); }
      }
      return {
        ok: checks.every(item => item.status === 'ok'), configured, checkedAt,
        provider: provider.listAccounts?.().find(account => account.id === kieAccountId)?.name || 'Kie.ai', model: model ? { id: model.id, name: model.name } : { id: String(modelId || ''), name: '' }, quote, balance,
        mechanism: {
          credentials: `Серверная переменная ${keyName}; значение не передаётся в браузер`,
          authorization: 'GET https://api.kie.ai/api/v1/chat/credit',
          tariffs: 'POST https://api.kie.ai/client/v1/model-pricing/page',
          generation: 'Сервер создаёт задачу Kie и опрашивает её статус; тест генерацию не запускает',
        },
        checks, recentLogs: providerDiagnostics.filter(entry => entry.kieAccountId === kieAccountId).slice(-25),
      };
    },
    async saveSource(file) {
      const saved = await assets.save(file);
      if (String(saved.type).startsWith('video/')) {
        const durationSeconds = mediaDurationSeconds(file.bytes, saved.type);
        if (durationSeconds) saved.durationSeconds = durationSeconds;
      }
      await sourceMetadata.update(assets.referenceId(saved.ref), { ...saved, chatId: file.chatId || null, projectId: file.projectId || null });
      return saved;
    },
    async sourceFile(id) {
      if (/^[a-f0-9-]{36}$/.test(id) && content) return content.file(accountId,id);
      if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Исходник не найден');
      const metadata = (await sourceMetadata.list()).find(item => item.id === id);
      if (!metadata) throw new Error('Исходник не найден');
      if (storage && await storage.head(assets.key(id)).then(() => true).catch(() => false)) return { storageKey: assets.key(id), name: metadata.name, type: metadata.type };
      return { path: path.join(assets.directory, id), type: metadata.type };
    },
    async resultFile(id, index) {
      const record = (await history.list()).find(item => item.id === id);
      if (!Number.isInteger(index) || index < 0 || !record?.localFiles?.[index]) throw new Error('Файл не найден');
      const file = record.localFiles[index];
      if (file.assetId) {
        const stored = await content.file(accountId,file.assetId);
        const extension = ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
          'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov' })[stored.type] || '';
        return { ...stored, name: extension && !path.extname(stored.name) ? `${stored.name}${extension}` : stored.name };
      }
      if (file.storageKey) {
        if (!storage || !file.storageKey.startsWith(`${storagePrefix}/results/`)) throw new Error('Файл вне S3-хранилища результатов');
        return file;
      }
      const relative = path.relative(path.join(directory, 'results'), file.path);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Файл вне хранилища результатов');
      return file;
    },
    async createTask(request) {
      // Serialize only retries of the same request id. Independent generation
      // requests may validate, reserve and enqueue concurrently.
      const chainKey = request?.requestId || 'legacy-without-request-id';
      const previous = enqueueChains.get(chainKey) || Promise.resolve();
      const operation = previous.then(()=>trace.request(()=>trace.step('generation.request',{request},async () => {
        const kieAccountId = request?.kieAccountId ?? 'primary';
        const selectedProvider = accountProvider(kieAccountId);
        const model = findModel(request?.modelId);
        request = { ...request, input: normalizePricingInput(model, request.input) };
        validate(model, request.input);
        if (!Array.isArray(request.sourceFiles || []) || (request.sourceFiles || []).length > 100) throw new Error('Некорректный список исходников');
        if (request.requestId && (typeof request.requestId !== 'string' || request.requestId.length > 150)) throw new Error('Некорректный идентификатор запроса');
        const binding = { projectId: request.projectId || null, chatId: request.chatId || null };
        const digest = createHash('sha256').update(JSON.stringify({ modelId: model.id, input: request.input, sourceFiles: request.sourceFiles || [], ...binding })).digest('hex');
        if (request.requestId) {
          const existing = (await history.list()).find(row => row.requestId === request.requestId);
          if (existing) {
            if ((existing.kieAccountId || 'primary') !== kieAccountId) throw new Error('Этот запрос уже сохранён для другого аккаунта Kie');
            if (existing.requestDigest !== digest) throw new Error('Этот запрос уже сохранён с другими параметрами');
            return existing;
          }
        }
        if (!selectedProvider.isConfigured()) throw new Error('Для выбранного аккаунта Kie не настроен ключ');
        const price = await costSettings();
        const cachedTariffs=(await preference('kie-tariffs',{})).data;
        const record = await queue.enqueue({
          kieAccountId,
          modelId: model.id, providerId: model.providerId, providerName: providers.find(item => item.id === model.providerId)?.name || model.providerId, model: model.apiModel,
          modelName: model.name, kind: model.kind, input: request.input,
          sourceFiles: request.sourceFiles || [], workspace: [1, 2, 3, 4, 5].includes(request.workspace) ? request.workspace : 1,
          ...binding,
          requestId: request.requestId || null, requestDigest: digest,
          // Refresh the official Kie list at the paid-submit boundary. The UI
          // quote may be cached to avoid a provider request on every field edit.
          ...(nativeBilling ? { nativeQuote: await service.nativeQuote(model.id, request.input, request.sourceFiles, true) } : {}),
          rubPerCredit: price.rubPerCredit, estimate: costs.quote(model, request.input, cachedTariffs)
        });
        // A generation click always resumed the queue through a second RPC. Wake it
        // here so the accepted record can start without waiting for another round trip.
        if(content) {
          const ids=(request.sourceFiles||[]).map(item=>assets.contentId(item.ref)).filter(Boolean);
          await Promise.all(ids.map((assetId,index)=>content.link(accountId,'history',record.id,assetId,'source',index)));
        }
        queue.start();
        return record;
      })));
      const settled = operation.catch(() => {});
      enqueueChains.set(chainKey, settled);
      try { return await operation; }
      finally { if (enqueueChains.get(chainKey) === settled) enqueueChains.delete(chainKey); }
    },
    async dispatch(method, args = []) {
      switch (method) {
        case 'getCatalog': return service.catalog();
        case 'nativeQuote': return service.nativeQuote(args[0]?.modelId, args[0]?.input, args[0]?.sourceFiles);
        case 'diagnoseProvider': return service.diagnoseProvider(args[0]?.modelId, args[0]?.input, args[0]?.sourceFiles, args[0]?.kieAccountId);
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
        case 'saveGenerationPreset': return presets.save(args[0], args[1]);
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
      while (queue.running || queue.polling) await new Promise(resolve => setTimeout(resolve, 20));
      await Promise.allSettled([...pendingSaves.values(), history.queue, preferences.queue, drafts.queue, sourceMetadata.queue]);
    }
  };
  if (content) {
    Promise.resolve().then(async () => {
      const records = await history.list();
      await Promise.allSettled(records.filter(record => record.state === 'success' && urls(record).length).map(record => saveResults(record.id)));
    }).catch(() => {});
  }
  return service;
}
module.exports = { createMediaService };
