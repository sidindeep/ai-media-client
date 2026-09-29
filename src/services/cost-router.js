const { createHash } = require('node:crypto');
const policy = require('../../config/cost-routing.json');
const compatibility = require('../../config/cost-routing-compatibility.json');

const MAX_PROMPT = 20000;
const AUTO_KIE_ACCOUNT_ID = 'primary';
const ID = /^[a-f0-9-]{36}$/;
const ELIGIBLE_RATIOS = new Set(['auto', '1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '5:4', '4:5', '2:1', '1:2', '3:1', '1:3', '21:9', '9:21']);
const NANO_RATIOS = new Set(['auto', '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']);

function normalizedRequest(raw, routingPolicy = policy) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Object.assign(new Error('Некорректный запрос выбора провайдера'), { status: 400 });
  const kieSelected = typeof raw.modelId === 'string' && raw.modelId.startsWith('kie:');
  const martSelected = typeof raw.modelId === 'string' && raw.modelId.startsWith('apimart:');
  const pair = compatibility.pairs.find(item => kieSelected ? item.kie === raw.modelId
    : martSelected && item.apimart === raw.modelId.slice(8));
  const input = raw.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || JSON.stringify(input).length > 40000
    || (input.prompt != null && (typeof input.prompt !== 'string' || input.prompt.length > MAX_PROMPT))
    || (raw.sourceFiles != null && (!Array.isArray(raw.sourceFiles) || raw.sourceFiles.length > 20
      || raw.sourceFiles.some(file => !file || typeof file !== 'object' || typeof file.ref !== 'string')))) {
    throw Object.assign(new Error('Некорректные параметры автоматического выбора'), { status: 400 });
  }
  const sharedPrompt = typeof input.prompt === 'string' && Boolean(input.prompt.trim());
  const noSources = !raw.sourceFiles || !raw.sourceFiles.length;
  const gptPair = pair?.profile === 'gpt-image-2'
    && Object.keys(input).every(key => ['prompt', 'aspect_ratio', 'resolution', 'background', 'input_urls'].includes(key))
    && sharedPrompt && (input.input_urls == null || Array.isArray(input.input_urls) && !input.input_urls.length)
    && ELIGIBLE_RATIOS.has(input.aspect_ratio ?? 'auto')
    && (input.resolution ?? '1K') === '1K' && input.background === 'opaque' && noSources;
  const nanoPair = pair?.profile === 'nano-banana-pro'
    && Object.keys(input).every(key => ['prompt', 'image_input', 'aspect_ratio', 'resolution', 'output_format'].includes(key))
    && sharedPrompt && input.prompt.length <= 10000
    && (input.image_input == null || Array.isArray(input.image_input) && !input.image_input.length)
    && NANO_RATIOS.has(input.aspect_ratio ?? '1:1')
    && ['1K', '2K', '4K'].includes(input.resolution ?? '1K')
    && (input.output_format ?? 'png') === 'png' && noSources;
  if (!kieSelected && !martSelected) throw Object.assign(new Error('Автоматический выбор для модели ещё недоступен'), { status: 400 });
  const model = { id: raw.modelId, routes: kieSelected
    ? [{ providerId: 'kie', modelId: raw.modelId }, pair
      ? { providerId: 'apimart', modelId: pair.apimart,
        profile: gptPair || nanoPair ? pair.profile : undefined, mapping: pair.mapping }
      : { providerId: 'apimart', modelId: '', unavailableReason: 'В таблице совместимости нет модели APIMart' }]
    : [{ providerId: 'apimart', modelId: raw.modelId.slice(8) }, { providerId: 'kie', modelId: pair?.kie || '',
      unavailableReason: pair ? 'Для этого варианта APIMart не подтверждён перевод параметров в Kie' : 'В таблице совместимости нет модели Kie' }] };
  const projectId = raw.projectId ?? null, chatId = raw.chatId ?? null;
  if ([projectId, chatId].some(value => value !== null && (typeof value !== 'string' || !ID.test(value)))) {
    throw Object.assign(new Error('Некорректный чат или проект'), { status: 400 });
  }
  return { model, generic: !gptPair && !nanoPair, input: gptPair ? { prompt: input.prompt.trim(), aspect_ratio: input.aspect_ratio ?? 'auto',
    resolution: input.resolution ?? '1K', background: 'opaque' }
    : nanoPair ? { ...input, prompt: input.prompt.trim(), aspect_ratio: input.aspect_ratio ?? '1:1',
      resolution: input.resolution ?? '1K', output_format: 'png' } : input,
    sourceFiles: raw.sourceFiles || [], projectId, chatId, requestId: raw.requestId };
}

function mappedParameters(request, model, mapping = {}) {
  if (model.promptRequired && !mapping.constants?.layer_decomposition && (typeof request.input.prompt !== 'string' || !request.input.prompt.trim()))
    throw new Error('Для APIMart нужен текстовый запрос');
  const fields = new Map((model.fields || []).map(field => [field.key, field]));
  const result = { ...mapping.constants };
  for (const [key, value] of Object.entries(request.input)) {
    if (key === 'prompt' || value == null) continue;
    if (Array.isArray(value) && !value.length) continue;
    if (key === 'output_format' && value === 'png' && !fields.has(key)
      || key === 'background' && value === 'opaque' && !fields.has(key)) continue;
    const target = mapping.fields?.[key] || (key === 'aspect_ratio' && fields.has('size') ? 'size'
      : ['image_input', 'input_urls', 'image_url'].includes(key) && fields.has('image_urls') ? 'image_urls' : key);
    const field = fields.get(target);
    if (!field) throw new Error(`Параметр ${key} не поддерживается APIMart`);
    if (field.type === 'files') {
      if (!field.uploadToApimart && !field.acceptsBase64) throw new Error(`Перенос исходников ${key} в APIMart не поддерживается`);
      const values = Array.isArray(value) ? value : [value];
      if (values.some(ref => typeof ref !== 'string' || !/^content:[a-f0-9-]{36}$/.test(ref)))
        throw new Error('Для APIMart загрузите исходники в хранилище сервиса');
      if (field.maxFiles && values.length > field.maxFiles || field.scalar && values.length !== 1)
        throw new Error(`Слишком много исходников для ${target}`);
      result[target] = field.scalar ? values[0] : values;
      continue;
    }
    const option = field.options?.find(item => String(item).toLowerCase() === String(value).toLowerCase());
    if (field.options?.length && option === undefined) throw new Error(`Значение ${key} не поддерживается APIMart`);
    result[target] = option ?? value;
  }
  const mappedRefs = new Set(Object.values(result).flat());
  if (request.sourceFiles.some(file => !mappedRefs.has(file.ref)))
    throw new Error('Не все исходники удалось перенести в APIMart');
  if (fields.has('n') && result.n === undefined) result.n = 1;
  for (const field of fields.values()) {
    if (field.required && result[field.key] == null && field.apiDefault == null && field.key !== 'prompt')
      throw new Error(`Обязательный параметр ${field.key} не передан в APIMart`);
  }
  return result;
}

function choose(offers) {
  const valid = offers.filter(offer => !offer.unavailable && Number.isFinite(offer.costUsd) && offer.costUsd > 0)
    .sort((a, b) => a.costUsd - b.costUsd || a.priority - b.priority);
  return valid[0] || null;
}

function createCostRouter({ accounts, apimart, pool, kieUsdPerCredit = policy.kieUsdPerCredit,
  routingPolicy = policy }) {
  if (!(kieUsdPerCredit > 0) || !Number.isFinite(kieUsdPerCredit)) throw new Error('Закупочная цена Kie не настроена');
  const key = (account, requestId) => `auto:${account}:${requestId}`;
  const apimartOptions = input => ({ size: input.aspect_ratio, resolution: input.resolution.toLowerCase(), n: 1 });
  const nanoApimartOptions = input => ({ size: input.aspect_ratio, resolution: input.resolution, n: 1 });
  const apimartParameters = (request, route, model) => route.profile === 'gpt-image-2'
    ? apimartOptions(request.input) : route.profile === 'nano-banana-pro'
      ? nanoApimartOptions(request.input) : route.providerId === 'apimart' && request.model.id.startsWith('apimart:')
        ? Object.fromEntries(Object.entries(request.input).filter(([key]) => key !== 'prompt'))
        : mappedParameters(request, model, route.mapping);
  async function quote(user, raw, { fresh = false } = {}) {
    const request = normalizedRequest(raw, routingPolicy);
    const wallet = await accounts.wallet.get(user.id);
    const attempts = await Promise.all(request.model.routes.map(async (route, priority) => {
      let offer;
      try {
        if (route.unavailableReason) throw new Error(route.unavailableReason);
        if (route.providerId === 'kie') {
          const scoped = await accounts.scope(user, user.id);
          if (!scoped.configured()) throw new Error('Kie не настроен');
          if (!(await scoped.catalog()).models.some(model => model.id === route.modelId))
            throw new Error('Модель Kie недоступна');
          const cost = await scoped.providerCostQuote(route.modelId, request.input, request.sourceFiles, fresh);
          if (!Number.isSafeInteger(cost.amountUnits) || cost.amountUnits <= 0) throw new Error('Цена Kie неизвестна');
          if (!Number.isFinite(cost.productCredits) || cost.productCredits <= 0) throw new Error('Цена в кредитах приложения неизвестна');
          const providerCredits = cost.amountUnits / 1000;
          offer = { providerId: 'kie', modelId: route.modelId, priority,
            costUsd: providerCredits * kieUsdPerCredit, providerCredits, usdPerProviderCredit: kieUsdPerCredit,
            credits: cost.productCredits,
            source: cost.source, tariffVersion: cost.version, costVersion: routingPolicy.version };
          if (wallet.balance < cost.productCredits) return { ...offer, unavailable: true, reason: 'Недостаточно кредитов сервиса' };
          const balance = await scoped.providerBalance(AUTO_KIE_ACCOUNT_ID);
          if (balance === null || balance < cost.amountUnits / 1000) return { ...offer, unavailable: true, reason: 'Недостаточно кредитов Kie' };
          return offer;
        }
        if (route.providerId === 'apimart') {
          if (!apimart) throw new Error('APIMart не настроен');
          const model = (await apimart.models()).find(item => item.id === route.modelId);
          if (!model) throw new Error('Модель APIMart недоступна');
          const parameters = apimartParameters(request, route, model);
          const cost = await apimart.quote({ model: route.modelId, prompt: request.input.prompt || '',
            parameters }, { fresh });
          if (cost.status !== 'estimated' || !Number.isFinite(cost.amountUsd) || cost.amountUsd <= 0) {
            throw new Error(cost.message || `Цена APIMart недоступна: ${cost.reason || 'провайдер не вернул тариф'}`);
          }
          if (!Number.isFinite(cost.nativeCredits) || cost.nativeCredits <= 0) throw new Error('Цена в кредитах APIMart неизвестна');
          if (!Number.isFinite(cost.credits) || cost.credits <= 0) throw new Error('Цена в кредитах приложения неизвестна');
          offer = { providerId: 'apimart', modelId: route.modelId, priority,
            costUsd: cost.amountUsd, nativeCredits: cost.nativeCredits,
            providerCredits: cost.nativeCredits, usdPerProviderCredit: cost.amountUsd / cost.nativeCredits,
            credits: cost.credits, warning: cost.warning,
            parameters, source: 'apimart-pricing', tariffVersion: 'live', costVersion: routingPolicy.version };
          if (wallet.balance < cost.credits) return { ...offer, unavailable: true, reason: 'Недостаточно кредитов сервиса' };
          const status = await apimart.status();
          if (!Number.isFinite(status.balance?.amount) || status.balance.amount < cost.amountUsd * 10) {
            return { ...offer, unavailable: true, reason: 'Недостаточно кредитов APIMart' };
          }
          return offer;
        }
        throw new Error('Провайдер не подключён к выбору');
      } catch (error) {
        return { ...offer, providerId: route.providerId, modelId: route.modelId, priority,
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
      sourceFiles: request.sourceFiles,
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
      return scoped.dispatch('createTask', [{ modelId: decision.selected.modelId, input: request.input,
        sourceFiles: request.sourceFiles, projectId: request.projectId, chatId: request.chatId, requestId: request.requestId,
        kieAccountId: AUTO_KIE_ACCOUNT_ID }]);
    }
    if (decision.selected.providerId === 'apimart') {
      return apimart.submit(user.id, { model: decision.selected.modelId, prompt: request.input.prompt || '',
        parameters: decision.selected.parameters, projectId: request.projectId, chatId: request.chatId,
        requestId: request.requestId });
    }
    throw new Error('Сохранённый провайдер недоступен');
  }
  return { quote, submit };
}

module.exports = { createCostRouter, normalizedRequest, choose };
