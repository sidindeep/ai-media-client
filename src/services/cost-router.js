const { createHash } = require('node:crypto');
const policy = require('../../config/cost-routing.json');
const routeSeed = require('../../config/model-routes.json');
const { readRouteDocument } = require('./service-model-configs');
const { modelRoutes } = require('./auto-model-routes');
const { readTask: readApimartTask, prepareTask: prepareApimartTask } = require('../providers/apimart/task-adapter');
const { readTask: readKieTask, prepareRouteTask: prepareKieTask } = require('../providers/kie/task-adapter');
const { models: kieModels } = require('../catalog');

const MAX_PROMPT = 20000;
const AUTO_KIE_ACCOUNT_ID = 'primary';
const ID = /^[a-f0-9-]{36}$/;

function normalizedRequest(raw, routes = routeSeed) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Object.assign(new Error('Некорректный запрос выбора провайдера'), { status: 400 });
  const row = routes.models.find(row => row.id === raw.modelId);
  const origin = raw.originModelId || (row ? row.providers.kie || (row.providers.apimart ? 'apimart:' + row.providers.apimart : '') : raw.modelId);
  if (row && !Object.entries(row.providers).some(([provider, id]) => (provider === 'apimart' ? 'apimart:' + id : id) === origin))
    throw Object.assign(new Error('Исходная модель не принадлежит выбранной строке'), { status: 400 });
  if (!row && raw.originModelId) throw Object.assign(new Error('Неизвестный ID модели проекта'), { status: 400 });
  const kieSelected = typeof origin === 'string' && origin.startsWith('kie:');
  const martSelected = typeof origin === 'string' && origin.startsWith('apimart:');
  const input = raw.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || JSON.stringify(input).length > 40000
    || (input.prompt != null && (typeof input.prompt !== 'string' || input.prompt.length > MAX_PROMPT))
    || (raw.sourceFiles != null && (!Array.isArray(raw.sourceFiles) || raw.sourceFiles.length > 20
      || raw.sourceFiles.some(file => !file || typeof file !== 'object' || typeof file.ref !== 'string')))) {
    throw Object.assign(new Error('Некорректные параметры автоматического выбора'), { status: 400 });
  }
  if (!kieSelected && !martSelected) throw Object.assign(new Error('Автоматический выбор для модели ещё недоступен'), { status: 400 });
  const model = { id: raw.modelId, routes: modelRoutes(raw.modelId, routes.models, origin) };
  const projectId = raw.projectId ?? null, chatId = raw.chatId ?? null;
  if ([projectId, chatId].some(value => value !== null && (typeof value !== 'string' || !ID.test(value)))) {
    throw Object.assign(new Error('Некорректный чат или проект'), { status: 400 });
  }
  const task = (kieSelected ? readKieTask : readApimartTask)({ ...raw, modelId: origin, action: row?.action || 'auto' });
  return { model, generic: true, task, input,
    sourceFiles: raw.sourceFiles || [], projectId, chatId, requestId: raw.requestId };
}

function choose(offers) {
  const valid = offers.filter(offer => !offer.unavailable && Number.isFinite(offer.costUsd) && offer.costUsd > 0)
    .sort((a, b) => a.costUsd - b.costUsd || a.priority - b.priority);
  return valid[0] || null;
}

function createCostRouter({ accounts, apimart, pool, kieUsdPerCredit = policy.kieUsdPerCredit,
  routingPolicy = policy, loadModelRoutes = readRouteDocument }) {
  if (!(kieUsdPerCredit > 0) || !Number.isFinite(kieUsdPerCredit)) throw new Error('Закупочная цена Kie не настроена');
  const key = (account, requestId) => `auto:${account}:${requestId}`;
  async function quote(user, raw, { fresh = false } = {}) {
    const request = normalizedRequest(raw, await loadModelRoutes(pool));
    const wallet = await accounts.wallet.get(user.id);
    const attempts = await Promise.all(request.model.routes.map(async (route, priority) => {
      let offer;
      try {
        if (route.unavailableReason) throw new Error(route.unavailableReason);
        if (route.providerId === 'kie') {
          const scoped = await accounts.scope(user, user.id);
          if (!scoped.configured()) throw new Error('Kie не настроен');
          const catalog = (await scoped.catalog()).models;
          const candidates = (route.modelIds || [route.modelId]).filter(id => catalog.some(model => model.id === id))
            .map(id => kieModels.find(model => model.id === id) || catalog.find(model => model.id === id));
          const prepared = prepareKieTask(request.task, candidates);
          const cost = await scoped.providerCostQuote(prepared.modelId, prepared.input, prepared.sourceFiles, fresh);
          if (!Number.isSafeInteger(cost.amountUnits) || cost.amountUnits <= 0) throw new Error('Цена Kie неизвестна');
          if (!Number.isFinite(cost.productCredits) || cost.productCredits <= 0) throw new Error('Цена в кредитах приложения неизвестна');
          const providerCredits = cost.amountUnits / 1000;
          offer = { providerId: 'kie', modelId: prepared.modelId, priority,
            costUsd: providerCredits * kieUsdPerCredit, providerCredits, usdPerProviderCredit: kieUsdPerCredit,
            credits: cost.productCredits, ...(cost.warning ? { warning: cost.warning } : {}),
            prepared, source: cost.source, tariffVersion: cost.version, costVersion: routingPolicy.version,
            adapterVersion: 'raw-task-v1' };
          if (wallet.balance < cost.productCredits) return { ...offer, unavailable: true, reason: 'Недостаточно кредитов сервиса' };
          const balance = await scoped.providerBalance(AUTO_KIE_ACCOUNT_ID);
          if (balance === null || balance < cost.amountUnits / 1000) return { ...offer, unavailable: true, reason: 'Недостаточно кредитов Kie' };
          return offer;
        }
        if (route.providerId === 'apimart') {
          if (!apimart) throw new Error('APIMart не настроен');
          const model = (await apimart.models()).find(item => item.id === route.modelId);
          if (!model) throw new Error('Модель APIMart недоступна');
          const prepared = prepareApimartTask(request.task, model);
          const parameters = prepared.parameters;
          const cost = await apimart.quote(prepared, { fresh });
          offer = { providerId: 'apimart', modelId: route.modelId, priority, publishedTariff: cost.publishedTariff };
          if (cost.status !== 'estimated' || !Number.isFinite(cost.amountUsd) || cost.amountUsd <= 0) {
            throw new Error(cost.message || `Цена APIMart недоступна: ${cost.reason || 'провайдер не вернул тариф'}`);
          }
          if (!Number.isFinite(cost.nativeCredits) || cost.nativeCredits <= 0) throw new Error('Цена в кредитах APIMart неизвестна');
          if (!Number.isFinite(cost.credits) || cost.credits <= 0) throw new Error('Цена в кредитах приложения неизвестна');
          offer = { providerId: 'apimart', modelId: route.modelId, priority,
            costUsd: cost.amountUsd, nativeCredits: cost.nativeCredits,
            providerCredits: cost.nativeCredits, usdPerProviderCredit: cost.amountUsd / cost.nativeCredits,
            credits: cost.credits, warning: cost.warning,
            publishedTariff: cost.publishedTariff,
            prepared, parameters, source: 'apimart-pricing', tariffVersion: 'live', costVersion: routingPolicy.version,
            adapterVersion: 'raw-task-v1' };
          if (wallet.balance < cost.credits) return { ...offer, unavailable: true, reason: 'Недостаточно кредитов сервиса' };
          const status = await apimart.status();
          if (!Number.isFinite(status.balance?.amount) || status.balance.amount < cost.amountUsd * 10) {
            return { ...offer, unavailable: true, reason: 'Недостаточно кредитов APIMart' };
          }
          return offer;
        }
        throw new Error('Провайдер не подключён к выбору');
      } catch (error) {
        if (route.providerId === 'apimart' && route.modelId && apimart && !offer?.publishedTariff) {
          try {
            const tariff = await apimart.quote({ model: route.modelId, prompt: request.input.prompt || '',
              parameters: {} }, { fresh });
            if (tariff.publishedTariff) offer = { ...offer, publishedTariff: tariff.publishedTariff };
          } catch { /* Keep the original route failure. */ }
        }
        return { ...offer, providerId: route.providerId, modelId: route.modelId, priority,
          unavailable: true, reason: error.message || 'Цена недоступна' };
      }
    }));
    const selected = choose(attempts);
    return { selected, offers: attempts };
  }
  async function submit(user, raw) {
    const request = normalizedRequest(raw, await loadModelRoutes(pool));
    if (typeof request.requestId !== 'string' || !ID.test(request.requestId)) {
      throw Object.assign(new Error('Некорректный ID запроса'), { status: 400 });
    }
    const digest = createHash('sha256').update(JSON.stringify({ modelId: request.model.id, input: request.input,
      sourceFiles: request.sourceFiles,
      ...(raw.originModelId ? { originModelId: raw.originModelId } : {}),
      projectId: request.projectId, chatId: request.chatId })).digest('hex');
    const recordId = key(user.id, request.requestId);
    const existing = async () => (await pool.query("SELECT data FROM media_records WHERE account_id=$1 AND namespace='auto-route' AND id=$2",
      [user.id, recordId])).rows[0]?.data;
    let decision = await existing();
    if (!decision) {
      await accounts.workspaces.assertBinding(user.id, request.projectId, request.chatId);
      const priced = await quote(user, raw, { fresh: true });
      if (!priced.selected) throw Object.assign(new Error(priced.offers.map(offer =>
        `${offer.providerId === 'kie' ? 'Kie' : 'APIMart'}: ${offer.reason}`).join('; ')), { status: 503 });
      const candidate = { requestId: request.requestId, digest, modelId: request.model.id,
        selected: priced.selected, offers: priced.offers, createdAt: new Date().toISOString() };
      await pool.query("INSERT INTO media_records(account_id,namespace,id,data) VALUES($1,'auto-route',$2,$3) ON CONFLICT DO NOTHING",
        [user.id, recordId, JSON.stringify(candidate)]);
      decision = await existing();
    }
    if (decision?.digest !== digest) throw Object.assign(new Error('Запрос с этим ID уже имеет другие параметры'), { status: 409 });
    if (decision.selected.providerId === 'kie') {
      const scoped = await accounts.scope(user, user.id);
      const prepared = decision.selected.prepared || { modelId: decision.selected.modelId, input: request.input, sourceFiles: request.sourceFiles };
      return scoped.dispatch('createTask', [{ ...prepared, projectId: request.projectId, chatId: request.chatId, requestId: request.requestId,
        kieAccountId: AUTO_KIE_ACCOUNT_ID }]);
    }
    if (decision.selected.providerId === 'apimart') {
      const prepared = decision.selected.prepared || { model: decision.selected.modelId, prompt: request.input.prompt || '', parameters: decision.selected.parameters };
      return apimart.submit(user.id, { ...prepared, projectId: request.projectId, chatId: request.chatId,
        requestId: request.requestId });
    }
    throw new Error('Сохранённый провайдер недоступен');
  }
  return { quote, submit };
}

module.exports = { createCostRouter, normalizedRequest, choose };
