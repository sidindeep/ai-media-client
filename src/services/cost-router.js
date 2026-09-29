const { createHash } = require('node:crypto');
const policy = require('../../config/cost-routing.json');

const MAX_PROMPT = 20000;
const ID = /^[a-f0-9-]{36}$/;
const ELIGIBLE_RATIOS = new Set(['auto', '1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '5:4', '4:5', '2:1', '1:2', '3:1', '1:3', '21:9', '9:21']);

function normalizedRequest(raw, routingPolicy = policy) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Object.assign(new Error('Некорректный запрос выбора провайдера'), { status: 400 });
  const model = routingPolicy.models.find(item => item.id === raw.modelId);
  if (!model) throw Object.assign(new Error('Автоматический выбор для модели ещё недоступен'), { status: 400 });
  const input = raw.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['prompt', 'aspect_ratio', 'resolution', 'background', 'input_urls'].includes(key))
    || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > MAX_PROMPT
    || (input.input_urls != null && (!Array.isArray(input.input_urls) || input.input_urls.length))
    || !ELIGIBLE_RATIOS.has(input.aspect_ratio ?? 'auto')
    || (input.resolution ?? '1K') !== '1K'
    || input.background !== 'opaque'
    || (raw.sourceFiles != null && (!Array.isArray(raw.sourceFiles) || raw.sourceFiles.length))) {
    throw Object.assign(new Error('Параметры этой модели пока не поддерживают автоматический выбор'), { status: 400 });
  }
  const projectId = raw.projectId ?? null, chatId = raw.chatId ?? null;
  if ([projectId, chatId].some(value => value !== null && (typeof value !== 'string' || !ID.test(value)))) {
    throw Object.assign(new Error('Некорректный чат или проект'), { status: 400 });
  }
  return { model, input: { prompt: input.prompt.trim(), aspect_ratio: input.aspect_ratio ?? 'auto',
    resolution: input.resolution ?? '1K', background: 'opaque' },
    projectId, chatId, requestId: raw.requestId };
}

function choose(offers) {
  const valid = offers.filter(offer => Number.isFinite(offer.costUsd) && offer.costUsd > 0)
    .sort((a, b) => a.costUsd - b.costUsd || a.priority - b.priority);
  if (!valid.length) throw Object.assign(new Error('Нет совместимого провайдера с известной ценой'), { status: 503 });
  return valid[0];
}

function createCostRouter({ accounts, apimart, pool, kieUsdPerCredit = policy.kieUsdPerCredit,
  routingPolicy = policy }) {
  if (!(kieUsdPerCredit > 0) || !Number.isFinite(kieUsdPerCredit)) throw new Error('Закупочная цена Kie не настроена');
  const key = (account, requestId) => `auto:${account}:${requestId}`;
  const apimartOptions = input => ({ size: input.aspect_ratio, resolution: input.resolution.toLowerCase(), n: 1 });
  async function quote(user, raw, { fresh = false } = {}) {
    const request = normalizedRequest(raw, routingPolicy);
    const scoped = await accounts.scope(user, user.id);
    const attempts = await Promise.all(request.model.routes.map(async (route, priority) => {
      try {
        if (route.providerId === 'kie') {
          if (!scoped.configured()) throw new Error('Kie не настроен');
          const cost = await scoped.providerCostQuote(route.modelId, request.input, [], fresh);
          if (!Number.isSafeInteger(cost.amountUnits) || cost.amountUnits <= 0) throw new Error('Цена Kie неизвестна');
          const balance = await scoped.providerBalance();
          if (balance === null || balance < cost.amountUnits / 1000) throw new Error('Недостаточно кредитов Kie');
          return { providerId: 'kie', modelId: route.modelId, priority,
            costUsd: cost.amountUnits / 1000 * kieUsdPerCredit,
            source: cost.source, tariffVersion: cost.version,
            costVersion: routingPolicy.version };
        }
        if (route.providerId === 'apimart') {
          if (!apimart) throw new Error('APIMart не настроен');
          const cost = await apimart.quote({ model: route.modelId, prompt: request.input.prompt,
            parameters: apimartOptions(request.input) });
          if (cost.status !== 'estimated' || !Number.isFinite(cost.amountUsd) || cost.amountUsd <= 0) {
            throw new Error('Цена APIMart неизвестна');
          }
          const status = await apimart.status();
          if (!Number.isFinite(status.balance?.amount) || status.balance.amount < cost.amountUsd * 10) {
            throw new Error('Недостаточно кредитов APIMart');
          }
          return { providerId: 'apimart', modelId: route.modelId, priority,
            costUsd: cost.amountUsd, source: 'apimart-pricing', tariffVersion: 'live',
            costVersion: routingPolicy.version };
        }
        throw new Error('Провайдер не подключён к выбору');
      } catch (error) {
        return { providerId: route.providerId, modelId: route.modelId, priority,
          unavailable: true, reason: error.message || 'Цена недоступна' };
      }
    }));
    const selected = choose(attempts);
    return { selected, offers: attempts };
  }
  async function submit(user, raw) {
    const request = normalizedRequest(raw, routingPolicy);
    if (typeof request.requestId !== 'string' || !ID.test(request.requestId)) {
      throw Object.assign(new Error('Некорректный ID запроса'), { status: 400 });
    }
    const digest = createHash('sha256').update(JSON.stringify({ modelId: request.model.id, input: request.input,
      projectId: request.projectId, chatId: request.chatId })).digest('hex');
    const recordId = key(user.id, request.requestId);
    const existing = async () => (await pool.query("SELECT data FROM media_records WHERE account_id=$1 AND namespace='auto-route' AND id=$2",
      [user.id, recordId])).rows[0]?.data;
    let decision = await existing();
    if (!decision) {
      await accounts.workspaces.assertBinding(user.id, request.projectId, request.chatId);
      const priced = await quote(user, raw, { fresh: true });
      const candidate = { requestId: request.requestId, digest, modelId: request.model.id,
        selected: priced.selected, offers: priced.offers, createdAt: new Date().toISOString() };
      await pool.query("INSERT INTO media_records(account_id,namespace,id,data) VALUES($1,'auto-route',$2,$3) ON CONFLICT DO NOTHING",
        [user.id, recordId, JSON.stringify(candidate)]);
      decision = await existing();
    }
    if (decision?.digest !== digest) throw Object.assign(new Error('Запрос с этим ID уже имеет другие параметры'), { status: 409 });
    if (decision.selected.providerId === 'kie') {
      const scoped = await accounts.scope(user, user.id);
      return scoped.dispatch('createTask', [{ modelId: decision.selected.modelId, input: request.input,
        sourceFiles: [], projectId: request.projectId, chatId: request.chatId, requestId: request.requestId,
        kieAccountId: 'primary' }]);
    }
    if (decision.selected.providerId === 'apimart') {
      return apimart.submit(user.id, { model: decision.selected.modelId, prompt: request.input.prompt,
        parameters: apimartOptions(request.input), projectId: request.projectId, chatId: request.chatId,
        requestId: request.requestId });
    }
    throw new Error('Сохранённый провайдер недоступен');
  }
  return { quote, submit };
}

module.exports = { createCostRouter, normalizedRequest, choose };
