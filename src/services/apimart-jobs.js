const { createApimartClient } = require('../providers/apimart/client');
const { safeMessage } = require('../provider-diagnostics');
const { appendGenerationEvent } = require('./generation-journal');
const { transaction } = require('../database/database');
const { defineProvider } = require('../providers/contract');
const { simpleRates, estimate, usedCost, mediaEstimate } = require('../providers/apimart/pricing');
const { describeModel, MUSIC_MODELS, SPEECH_MODELS, MODEL_ID } = require('../providers/apimart/catalog');
const { isDeepStrictEqual } = require('node:util');

const NAMESPACE = 'apimart';
const MODEL_TTL_MS = 10 * 60 * 1000;
const UUID = /^[a-f0-9-]{36}$/;
const POLL_MS = 5000;
const POLL_LIMIT = 360;
function parameters(raw) {
  const value = raw?.parameters ?? {};
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(value).length > 16000 || Object.keys(value).some(key => ['model', 'prompt', 'sound_prompt', '__proto__', 'constructor'].includes(key))) {
    throw Object.assign(new Error('Некорректные параметры APIMart'), { status: 400 });
  }
  return value;
}
function taskUrls(task) {
  const result = task?.result || {};
  const urls = [];
  if (Array.isArray(task?.image_urls)) urls.push(...task.image_urls);
  for (const item of [...(result.images || []), ...(result.videos || []), ...(result.music || []), ...(result.audio || [])]) {
    if (Array.isArray(item?.url)) urls.push(...item.url);
    else if (typeof item?.url === 'string') urls.push(item.url);
    for (const key of ['audio_url', 'video_url']) if (typeof item?.[key] === 'string') urls.push(item[key]);
  }
  return [...new Set(urls.filter(url => typeof url === 'string' && /^https:\/\//.test(url)))];
}

function createApimartJobs({ pool, apiKey, content, fetchImpl, now = Date.now }) {
  const client = createApimartClient({ apiKey, ...(fetchImpl ? { fetchImpl } : {}) });
  let cachedModels = null;
  let expiresAt = 0;
  let pending = null;
  const pricingCache = new Map();
  async function tariff(model) {
    const cached = pricingCache.get(model);
    if (cached && cached.expiresAt > now()) return cached.value;
    const value = await client.pricing(model);
    pricingCache.set(model, { value, expiresAt: now() + MODEL_TTL_MS });
    return value;
  }
  const rates = async model => simpleRates(await tariff(model));
  async function quote(raw) {
    if (!raw || typeof raw.model !== 'string' || !MODEL_ID.test(raw.model)
      || typeof raw.prompt !== 'string' || raw.prompt.length > 20000) {
      throw Object.assign(new Error('Некорректный запрос APIMart'), { status: 400 });
    }
    const model = (await models()).find(item => item.id === raw.model);
    if (!model) throw Object.assign(new Error('Модель APIMart недоступна'), { status: 403 });
    const options = parameters(raw);
    if (model.kind === 'text') {
      const tariff = await rates(raw.model);
      return tariff ? { status: 'estimated', credits: null, ...estimate(tariff, raw.prompt) }
        : { status: 'unavailable', credits: null, reason: 'unsupported_tariff' };
    }
    return mediaEstimate(await tariff(raw.model), model, options)
      || { status: 'unavailable', credits: null, reason: 'unsupported_tariff' };
  }
  async function status() {
    const result = await client.balance();
    const amount = result?.remain_credits;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
      throw new Error('APIMart не вернул остаток кредитов аккаунта');
    }
    return { configured: true, balance: { amount, unit: 'credits' } };
  }
  async function models() {
    if (cachedModels && now() < expiresAt) return cachedModels;
    if (!pending) pending = (async () => {
      const response = await client.models();
      if (!Array.isArray(response?.data)) throw new Error('APIMart вернул неверный каталог');
      cachedModels = response.data.map(describeModel).filter(Boolean);
      expiresAt = now() + MODEL_TTL_MS;
      return cachedModels;
    })().finally(() => { pending = null; });
    return pending;
  }
  const recordId = (account, requestId) => `apimart:${account}:${requestId}`;
  async function get(account, requestId) {
    return (await pool.query("SELECT data FROM media_records WHERE account_id=$1 AND namespace='apimart' AND id=$2",
      [account, recordId(account, requestId)])).rows[0]?.data || null;
  }
  async function finish(account, job, state, patch) {
    const completedAt = new Date().toISOString();
    const next = { ...job, ...patch, state, revision: job.revision + 1, updatedAt: completedAt, completedAt,
      durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(job.createdAt)) };
    await transaction(pool, async db => {
      await db.query("UPDATE media_records SET data=$3,updated_at=now() WHERE account_id=$1 AND namespace='apimart' AND id=$2",
        [account, recordId(account, job.id), JSON.stringify(next)]);
      await appendGenerationEvent(db, account, NAMESPACE, next, state, { error: next.error });
    });
    return next;
  }
  async function progress(account, job, patch) {
    const next = { ...job, ...patch, revision: job.revision + 1, updatedAt: new Date().toISOString() };
    await pool.query("UPDATE media_records SET data=$3,updated_at=now() WHERE account_id=$1 AND namespace='apimart' AND id=$2",
      [account, recordId(account, job.id), JSON.stringify(next)]);
    return next;
  }
  async function saveBuffer(account, job, bytes, type = 'audio/wav', index = 0) {
    if (!content) throw new Error('Хранилище результатов не настроено');
    const extension = { 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[type] || 'bin';
    const asset = await content.createFromBuffer(account, { bytes, name: `${job.id}-${index}.${extension}`, type,
      origin: { kind: 'result', provider: 'apimart', recordId: recordId(account, job.id), position: index } });
    await content.link(account, 'apimart', recordId(account, job.id), asset.id, 'result', index);
    await content.wait(account, asset.id);
    return `/api/content/${asset.id}`;
  }
  async function saveUrls(account, job, urls) {
    return Promise.all(urls.map(async (url, index) => {
      if (!content) return url;
      try {
        const asset = await content.createFromUrl(account, { url, name: `${job.id}-${index}`,
          origin: { kind: 'result', provider: 'apimart', recordId: recordId(account, job.id), position: index } });
        await content.link(account, 'apimart', recordId(account, job.id), asset.id, 'result', index);
        await content.wait(account, asset.id);
        return `/api/content/${asset.id}`;
      } catch { return url; }
    }));
  }
  async function prepareParameters(account, job) {
    const options = { ...job.parameters };
    let totalBytes = 0, position = 0;
    for (const key of job.imageUploadFields || job.base64Fields || []) {
      const resolve = async value => {
        const id = /^content:([a-f0-9-]{36})$/.exec(String(value || ''))?.[1];
        if (!id) return value;
        if (!content) throw Object.assign(new Error('Хранилище исходников недоступно'), { confirmedRejected: true });
        const file = await content.file(account, id);
        if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw Object.assign(new Error('Неподдерживаемый формат исходника'), { confirmedRejected: true });
        const bytes = await content.read(account, id);
        totalBytes += bytes.length;
        if (bytes.length > 20 * 1024 * 1024 || totalBytes > 50 * 1024 * 1024) throw Object.assign(new Error('Исходные изображения слишком большие'), { confirmedRejected: true });
        await content.link(account, 'apimart', recordId(account, job.id), id, 'source', position++);
        const uploaded = await client.uploadImage(bytes, file.name || 'image', file.type);
        if (!/^https:\/\//.test(uploaded?.url || '')) throw Object.assign(new Error('APIMart не вернул ссылку на загруженное изображение'), { confirmedRejected: true });
        return uploaded.url;
      };
      if (Array.isArray(options[key])) {
        const resolved = [];
        for (const value of options[key]) resolved.push(await resolve(value));
        options[key] = resolved;
      } else if (options[key] != null) options[key] = await resolve(options[key]);
    }
    return options;
  }
  async function poll(account, job) {
    let current = job;
    for (let count = 0; count < POLL_LIMIT; count++) {
      let response;
      try { response = await client.task(current.providerTaskId, current.kind); }
      catch (error) {
        // Polling is read-only and safe to retry. Never resubmit a paid generation.
        if (!error.confirmedRejected || [404, 408, 429, 500, 502, 503, 504].includes(error.status)) {
          await new Promise(resolve => setTimeout(resolve, POLL_MS)); continue;
        }
        return finish(account, current, 'unknown', { error: safeMessage(error.message) });
      }
      const task = response?.data;
      if (!task || typeof task !== 'object') throw new Error('APIMart вернул неверный статус задачи');
      const state = String(task.status || '').toLowerCase();
      if (['completed', 'success', 'succeeded'].includes(state)) {
        const urls = taskUrls(task);
        if (!urls.length) return finish(account, current, 'unknown', { error: 'APIMart завершил задачу без ссылки на результат.' });
        const savedUrls = await saveUrls(account, current, urls);
        const credits = Number.isFinite(task.credits_cost) && task.credits_cost >= 0 ? task.credits_cost : null;
        const usd = Number.isFinite(task.cost) && task.cost >= 0 ? task.cost : credits != null ? credits / 10 : null;
        return finish(account, current, 'success', { resultUrls: savedUrls,
          apimartTariffCost: usd != null ? { amountUsd: usd, nativeCredits: credits ?? usd * 10, confirmed: true } : null });
      }
      if (['failed', 'failure', 'canceled', 'cancelled'].includes(state)) {
        return finish(account, current, 'fail', { error: safeMessage(task.error?.message || task.error || 'Генерация APIMart завершилась ошибкой') });
      }
      if (Number.isFinite(task.progress) && task.progress !== current.progress) current = await progress(account, current, { progress: task.progress });
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
    }
    return finish(account, current, 'unknown', { error: 'APIMart долго не завершает задачу. Проверьте задачу в кабинете.' });
  }
  async function process(account, job) {
    let sent = false;
    const send = async action => {
      await appendGenerationEvent(pool, account, NAMESPACE, job, 'send_start');
      sent = true;
      return action();
    };
    try {
      if (job.kind === 'audio' && SPEECH_MODELS.has(job.model)) {
        const bytes = await send(() => client.speech({ model: job.model, input: job.prompt,
          voice: job.parameters.voice || 'alloy', response_format: 'mp3' }));
        const url = await saveBuffer(account, job, bytes, 'audio/mpeg');
        return finish(account, job, 'success', { resultUrls: [url] });
      }
      if (job.kind === 'audio' && job.model === 'whisper-1') {
        const sourceId = /^content:([a-f0-9-]{36})$/.exec(String(job.parameters.audio_file || ''))?.[1];
        if (!sourceId || !content) throw Object.assign(new Error('Добавьте аудиофайл для распознавания'), { confirmedRejected: true });
        const file = await content.file(account, sourceId);
        const bytes = await content.read(account, sourceId);
        if (bytes.length > 25 * 1024 * 1024) throw Object.assign(new Error('Аудиофайл превышает 25 МБ'), { confirmedRejected: true });
        const response = await send(() => client.transcribe(job.model, bytes, file.name || 'audio.mp3', job.parameters));
        const output = typeof response?.text === 'string' ? response.text : response?.data?.text;
        if (typeof output !== 'string') throw new Error('APIMart не вернул текст распознавания');
        return finish(account, job, 'success', { output });
      }
      if (job.kind === 'audio' && !MUSIC_MODELS.has(job.model)) {
        const response = await send(() => client.audioChat(job.model, job.prompt, job.parameters));
        const message = response?.choices?.[0]?.message;
        const encoded = message?.audio?.data;
        if (typeof encoded !== 'string' || encoded.length > 70 * 1024 * 1024) throw new Error('APIMart не вернул аудиоответ');
        const url = await saveBuffer(account, job, Buffer.from(encoded, 'base64'));
        const tariff = await rates(job.model).catch(() => null);
        return finish(account, job, 'success', { resultUrls: [url], output: message.content || null,
          usage: response.usage || null, apimartTariffCost: tariff ? usedCost(tariff, response.usage) : null });
      }
      if (job.kind !== 'text') {
        const body = { ...await prepareParameters(account, job), model: job.model,
          ...(job.model === 'flowmusic' ? { sound_prompt: job.prompt } : { prompt: job.prompt }) };
        if (job.model === 'midjourney') delete body.model;
        const response = await send(() => client.generate(job.endpoint, body));
        const immediate = Array.isArray(response?.data) ? response.data.filter(item => item?.url || item?.b64_json) : [];
        if (immediate.length) {
          const urls = await Promise.all(immediate.map(async (item, index) => {
            if (typeof item.url === 'string' && /^https:\/\//.test(item.url)) return item.url;
            if (typeof item.b64_json !== 'string' || item.b64_json.length > 45 * 1024 * 1024) throw new Error('Некорректный ответ изображения APIMart');
            const bytes = Buffer.from(item.b64_json, 'base64');
            const type = bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg' : bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : 'image/png';
            return saveBuffer(account, job, bytes, type, index);
          }));
          const saved = urls.every(url => url.startsWith('https://')) ? await saveUrls(account, job, urls) : urls;
          return finish(account, job, 'success', { resultUrls: saved, usage: response.usage || null });
        }
        const providerTaskId = response?.data?.[0]?.task_id || response?.data?.task_id;
        if (typeof providerTaskId !== 'string' || providerTaskId.length > 200) {
          return finish(account, job, 'unknown', { error: 'APIMart не вернул ID задачи. Проверьте расход в кабинете.' });
        }
        job = await progress(account, job, { providerTaskId });
        return await poll(account, job);
      }
      const response = await send(() => client.text(job.model, job.prompt, job.endpoint));
      const output = response?.choices?.[0]?.message?.content ?? response?.choices?.[0]?.text
        ?? response?.output?.flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text).join('\n');
      if (typeof output !== 'string' || !output.trim() || output.length > 2 * 1024 * 1024) {
        return finish(account, job, 'unknown', { error: 'APIMart вернул пустой или слишком большой ответ. Проверьте расход в кабинете.' });
      }
      const tariff = await rates(job.model).catch(() => null);
      return finish(account, job, 'success', { output, usage: response.usage || null,
        apimartTariffCost: tariff ? usedCost(tariff, response.usage) : null });
    } catch (error) {
      const state = !sent || error.confirmedRejected ? 'fail' : 'unknown';
      return finish(account, job, state, { error: state === 'fail' ? safeMessage(error.message)
        : 'Исход запроса APIMart неизвестен. Проверьте расход в кабинете перед повтором.' });
    }
  }
  async function submit(account, raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || Object.keys(raw).some(key => !['requestId', 'model', 'prompt', 'parameters', 'projectId', 'chatId'].includes(key))
      || typeof raw.requestId !== 'string' || !UUID.test(raw.requestId)
      || typeof raw.prompt !== 'string' || raw.prompt.length > 20000
      || typeof raw.model !== 'string' || !MODEL_ID.test(raw.model)
      || [raw.projectId, raw.chatId].some(value => value != null && (typeof value !== 'string' || !UUID.test(value)))) {
      throw Object.assign(new Error('Некорректный запрос APIMart'), { status: 400 });
    }
    const options = parameters(raw);
    const matches = existing => existing.model === raw.model && existing.prompt === raw.prompt.trim()
      && isDeepStrictEqual(existing.parameters || {}, options)
      && (existing.chatId || null) === (raw.chatId || null) && (existing.projectId || null) === (raw.projectId || null);
    const existing = await get(account, raw.requestId);
    if (existing) {
      if (!matches(existing)) {
        throw Object.assign(new Error('Запрос с этим ID уже имеет другие параметры'), { status: 409 });
      }
      return existing;
    }
    const model = (await models()).find(item => item.id === raw.model);
    if (!model) throw Object.assign(new Error('Модель APIMart недоступна'), { status: 403 });
    if (model.promptRequired && !raw.prompt.trim()) throw Object.assign(new Error('Введите промпт'), { status: 400 });
    for (const field of model.fields) {
      const value = options[field.key];
      if (field.required && (value == null || value === '' || Array.isArray(value) && !value.length)) {
        throw Object.assign(new Error(`Заполните поле: ${field.label || field.key}`), { status: 400 });
      }
      if (value == null || value === '') continue;
      const invalid = field.type === 'number' && !Number.isFinite(value)
        || field.type === 'boolean' && typeof value !== 'boolean'
        || field.type === 'string' && typeof value !== 'string'
        || field.schema?.type === 'array' && !Array.isArray(value)
        || field.schema?.type === 'object' && (typeof value !== 'object' || Array.isArray(value))
        || field.options?.length && !field.options.includes(value)
        || field.maxFiles && Array.isArray(value) && value.length > field.maxFiles;
      if (invalid) throw Object.assign(new Error(`Некорректное значение: ${field.label || field.key}`), { status: 400 });
    }
    const createdAt = new Date().toISOString();
    const job = { id: raw.requestId, requestId: raw.requestId, model: raw.model, prompt: raw.prompt.trim(), kind: model.kind,
      parameters: options, endpoint: model.endpoint,
      imageUploadFields: model.fields.filter(field => field.uploadToApimart || field.acceptsBase64).map(field => field.key),
      state: 'running', revision: 1, createdAt, updatedAt: createdAt,
      projectId: raw.projectId || null, chatId: raw.chatId || null };
    try {
      await transaction(pool, async db => {
        await db.query("INSERT INTO media_records(account_id,namespace,id,data) VALUES($1,'apimart',$2,$3)",
          [account, recordId(account, raw.requestId), JSON.stringify(job)]);
        await appendGenerationEvent(db, account, NAMESPACE, job, 'created');
      });
    } catch (error) {
      if (error.code === '23505') {
        const accepted = await get(account, raw.requestId);
        if (accepted && matches(accepted)) return accepted;
        throw Object.assign(new Error('Запрос с этим ID уже имеет другие параметры'), { status: 409 });
      }
      throw error;
    }
    void process(account, job).catch(() => {});
    return job;
  }
  async function recover() {
    const rows = (await pool.query("SELECT account_id,data FROM media_records WHERE namespace='apimart' AND data->>'state'='running'")).rows;
    for (const row of rows) {
      if (row.data.providerTaskId) void poll(row.account_id, row.data).catch(error =>
        finish(row.account_id, row.data, 'unknown', { error: safeMessage(error.message) })).catch(() => {});
      else await finish(row.account_id, row.data, 'unknown',
        { error: 'Сервис перезапущен во время запроса APIMart. Проверьте расход в кабинете перед повтором.' });
    }
  }
  const provider = defineProvider({
    id: 'apimart', name: 'APIMart', kinds: ['text', 'image', 'video', 'audio'], billing: { mode: 'external', unit: null },
    listModels: models,
    quote,
    submit, getTask: get,
    getStatus: status,
  });
  return { models: provider.listModels, quote: provider.quote, status: provider.getStatus,
    get: provider.getTask, submit: provider.submit, recover, provider };
}

module.exports = { createApimartJobs };
