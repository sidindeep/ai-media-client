const { transaction } = require('../database/database');
const { reserve, settle, lockWallet } = require('../billing/wallet');
const { createRouterAiClient } = require('../providers/routerai/client');
const { quoteRouterAi } = require('../providers/routerai/pricing');
const { evaluateQuote, unpricedQuote } = require('../billing/quote-engine');
const { appendGenerationEvent } = require('./generation-journal');
const { createCreditConversion } = require('../billing/conversion');
const { validatePng, MAX_IMAGE_BYTES } = require('./codex-images');
const catalog = require('../../config/routerai-models.json');

function invalid(message) { return Object.assign(new Error(message), { status: 400 }); }
function streamedWav(events) {
  const chunks = [];
  for (const line of events.split(/\r?\n/)) {
    if (!line.startsWith('data: ')) continue;
    try {
      const event = JSON.parse(line.slice(6));
      const encoded = event?.choices?.[0]?.delta?.audio?.data;
      if (typeof encoded === 'string') chunks.push(Buffer.from(encoded, 'base64'));
    } catch { /* [DONE] or another non-JSON SSE event */ }
  }
  if (!chunks.length) return null;
  const pcm = Buffer.concat(chunks);
  if (pcm.length > 64 * 1024 * 1024 - 44) throw new Error('Аудио RouterAI слишком большое');
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + pcm.length, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
  return wav;
}
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

function createRouterAiBilling({ accounts, apiKey, content, fetchImpl, tariffFetcher }) {
  const client = createRouterAiClient({ apiKey, ...(fetchImpl ? { fetchImpl } : {}) });
  const id = (account, requestId) => `routerai:${account}:${requestId}`;
  const conversion = accounts.conversion || createCreditConversion();
  const quote = async (request, _role = 'user', force = false) => {
    try {
      const model = await tariffFetcher(request.model, force);
      const result = evaluateQuote(() => quoteRouterAi(model, request), () => 'price_unavailable');
      if (result.status === 'unavailable') return unpricedQuote('price_unavailable');
      return conversion.quote('routerai', result.quote);
    } catch { return unpricedQuote('price_unavailable'); }
  };
  async function get(account, requestId) {
    return (await accounts.pool.query("SELECT data FROM media_records WHERE account_id=$1 AND namespace='routerai' AND id=$2", [account, id(account, requestId)])).rows[0]?.data;
  }
  async function markVideo(account, request, providerVideoId) {
    await transaction(accounts.pool, async db => {
      await db.query("UPDATE media_records SET data=jsonb_set(data,'{providerVideoId}',to_jsonb($3::text)),updated_at=now() WHERE account_id=$1 AND namespace='routerai' AND id=$2", [account, id(account, request.requestId), providerVideoId]);
      await appendGenerationEvent(db, account, 'routerai', request, 'accepted', { providerTaskId: providerVideoId });
    });
  }
  async function finish(account, requestId, patch) {
    return transaction(accounts.pool, async db => {
      await lockWallet(db, account);
      const row = (await db.query("SELECT data FROM media_records WHERE account_id=$1 AND namespace='routerai' AND id=$2 FOR UPDATE", [account, id(account, requestId)])).rows[0];
      if (!row) throw new Error('Запрос RouterAI не найден');
      if (['success', 'fail'].includes(row.data.state)) return row.data;
      const now = new Date().toISOString();
      const next = { ...row.data, ...patch, revision: row.data.revision + 1, updatedAt: now, completedAt: now,
        durationMs: Math.max(0, Date.parse(now) - Date.parse(row.data.createdAt)) };
      await settle(db, account, id(account, requestId), next.state, next);
      await db.query("UPDATE media_records SET data=$3,updated_at=now() WHERE account_id=$1 AND namespace='routerai' AND id=$2", [account, id(account, requestId), JSON.stringify(next)]);
      await appendGenerationEvent(db, account, 'routerai', next, next.state,
        { providerCostRub: next.providerCostRub, error: next.error });
      return next;
    });
  }
  async function process(account, request) {
    try {
      await appendGenerationEvent(accounts.pool, account, 'routerai', request, 'send_start');
      if (request.kind === 'api') {
        const payload = { ...request.payload };
        if (request.endpoint === 'audio/transcriptions' && typeof payload.input_audio?.data === 'string'
          && /^content:[a-f0-9-]{36}$/.test(payload.input_audio.data)) {
          const bytes = await content.read(account, payload.input_audio.data.slice('content:'.length));
          payload.input_audio = { ...payload.input_audio, data: bytes.toString('base64') };
        }
        const result = await client.raw(request.endpoint, { ...payload, model: request.model });
        if (request.endpoint === 'videos') {
          const providerVideoId = result.type === 'json' && typeof result.data?.id === 'string' ? result.data.id : null;
          if (!providerVideoId) throw new Error('RouterAI не вернул ID видеозадачи');
          await markVideo(account, request, providerVideoId);
          for (let attempt = 0; attempt < 144; attempt++) {
            const status = await client.video(providerVideoId);
            const state = String(status?.status || status?.data?.status || '').toLowerCase();
            if (['completed', 'succeeded', 'success'].includes(state)) {
              const bytes = await client.video(providerVideoId, true);
              const asset = await content.createFromBuffer(account, { bytes, name: request.requestId + '.mp4', type: 'video/mp4',
                origin: { kind: 'result', provider: 'routerai', recordId: id(account, request.requestId), position: 0 } });
              await content.link(account, 'routerai', id(account, request.requestId), asset.id, 'result', 0);
              return finish(account, request.requestId, { state: 'success', contentAssetId: asset.id, resultType: 'video/mp4',
                providerCostRub: typeof status?.usage?.cost === 'number' && Number.isFinite(status.usage.cost) ? status.usage.cost : null,
                output: 'Видео RouterAI готово.' });
            }
            if (['failed', 'error', 'cancelled', 'canceled'].includes(state)) return finish(account, request.requestId, { state: 'fail', error: 'RouterAI не создал видео.' });
            await new Promise(resolve => setTimeout(resolve, 5000));
          }
          return finish(account, request.requestId, { state: 'unknown', error: request.nativeQuote?.amountUnits == null
            ? 'Видеозадача RouterAI выполняется дольше 12 минут. Результат требует проверки.'
            : 'Видеозадача RouterAI выполняется дольше 12 минут. Резерв сохранён до проверки.' });
        }
        if (result.type === 'text' && request.modelKind === 'audio') {
          const wav = streamedWav(result.data);
          if (wav) {
            const asset = await content.createFromBuffer(account, { bytes: wav, name: request.requestId + '.wav', type: 'audio/wav',
              origin: { kind: 'result', provider: 'routerai', recordId: id(account, request.requestId), position: 0 } });
            await content.link(account, 'routerai', id(account, request.requestId), asset.id, 'result', 0);
            return finish(account, request.requestId, { state: 'success', contentAssetId: asset.id, resultType: 'audio/wav', output: 'Аудио RouterAI готово.' });
          }
        }
        if (result.type === 'binary') {
          const mime = result.mime === 'application/octet-stream' && request.endpoint === 'audio/speech'
            ? ({ mp3: 'audio/mpeg', wav: 'audio/wav', pcm: 'audio/pcm' }[request.payload.response_format] || 'audio/mpeg') : result.mime;
          const extension = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/pcm': 'pcm', 'video/mp4': 'mp4', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[mime];
          if (!extension) throw new Error('Формат ответа RouterAI требует ручной проверки');
          const type = mime === 'audio/mp3' ? 'audio/mpeg' : mime;
          const asset = await content.createFromBuffer(account, { bytes: result.data, name: request.requestId + '.' + extension, type,
            origin: { kind: 'result', provider: 'routerai', recordId: id(account, request.requestId), position: 0 } });
          await content.link(account, 'routerai', id(account, request.requestId), asset.id, 'result', 0);
          return finish(account, request.requestId, { state: 'success', contentAssetId: asset.id, resultType: type, output: 'Файл RouterAI готов.' });
        }
        const output = result.type === 'json' ? JSON.stringify(result.data) : result.data;
        if (typeof output !== 'string' || output.length > 2 * 1024 * 1024) throw new Error('Ответ RouterAI слишком большой для истории');
        return finish(account, request.requestId, { state: 'success', output,
          providerCostRub: result.type === 'json' && typeof result.data?.usage?.cost === 'number' ? result.data.usage.cost : null });
      }
      if (request.kind === 'text') {
        const result = await client.chatCompletion({ model: request.model, messages: [{ role: 'user', content: request.prompt }] });
        const output = result?.choices?.[0]?.message?.content;
        if (typeof output !== 'string' || !output.trim()) throw new Error('Пустой ответ RouterAI');
        return finish(account, request.requestId, { state: 'success', output, usage: result.usage || null,
          providerCostRub: typeof result.usage?.cost === 'number' ? result.usage.cost : null });
      }
      const result = request.endpoint === 'chat/completions'
        ? await client.chatCompletion({ model: request.model, messages: [{ role: 'user', content: request.prompt }], modalities: ['image', 'text'] })
        : await client.generateImage({ model: request.model, prompt: request.prompt, n: 1,
          ...(request.outputFormat === 'svg' ? { output_format: 'svg' } : {}) });
      const source = request.endpoint === 'chat/completions' ? result?.choices?.[0]?.message?.images?.[0]?.image_url?.url : result?.data?.[0]?.b64_json;
      const encoded = typeof source === 'string' ? source.replace(/^data:image\/[a-z+.-]+;base64,/, '') : null;
      if (typeof encoded !== 'string' || encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error('Изображение RouterAI не получено');
      const image = Buffer.from(encoded, 'base64');
      let type, extension;
      if (image.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) { validatePng(image); type = 'image/png'; extension = 'png'; }
      else if (image.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) { type = 'image/jpeg'; extension = 'jpg'; }
      else if (image.toString('ascii', 0, 4) === 'RIFF' && image.toString('ascii', 8, 12) === 'WEBP') { type = 'image/webp'; extension = 'webp'; }
      else if (request.outputFormat === 'svg' && /^\s*<svg\b/i.test(image.toString('utf8', 0, 512))) { type = 'image/svg+xml'; extension = 'svg'; }
      else throw new Error('RouterAI вернул неподдерживаемый формат изображения');
      if (!image.length || image.length > MAX_IMAGE_BYTES) throw new Error('Изображение RouterAI слишком большое');
      const asset = await content.createFromBuffer(account, { bytes: image, name: request.requestId + '.' + extension, type,
        origin: { kind: 'result', provider: 'routerai', recordId: id(account, request.requestId), position: 0 } });
      await content.link(account, 'routerai', id(account, request.requestId), asset.id, 'result', 0);
      return finish(account, request.requestId, { state: 'success', contentAssetId: asset.id, hasImage: true, imageType: type,
        usage: result.usage || null, providerCostRub: typeof result.usage?.cost === 'number' ? result.usage.cost : null });
    } catch (error) {
      const rejected = [400, 401, 402, 403, 404, 422, 429].includes(error.status);
      return finish(account, request.requestId, { state: rejected ? 'fail' : 'unknown',
        error: rejected ? error.message : request.nativeQuote?.amountUnits == null
          ? 'Результат RouterAI требует проверки.' : 'Результат RouterAI требует проверки. Резерв кредитов сохранён.' });
    }
  }
  async function save(account, request, role) {
    const matches = previous => !['model', 'prompt', 'projectId', 'chatId', 'endpoint'].some(key => (previous[key] ?? null) !== (request[key] ?? null))
      && JSON.stringify(previous.payload || null) === JSON.stringify(request.payload || null);
    const existing = await get(account, request.requestId);
    if (existing) {
      if (!matches(existing)) throw Object.assign(new Error('Запрос с этим ID уже имеет другие параметры'), { status: 409 });
      return existing;
    }
    const nativeQuote = await quote(request, role, true);
    if (request.quotedAmountUnits !== undefined && nativeQuote.amountUnits !== null && request.quotedAmountUnits !== nativeQuote.amountUnits) {
      throw Object.assign(new Error('Тариф RouterAI изменился. Обновите цену перед отправкой.'), { status: 409 });
    }
    let fresh = false;
    const job = await transaction(accounts.pool, async db => {
      await lockWallet(db, account);
      const previous = (await db.query("SELECT data FROM media_records WHERE account_id=$1 AND namespace='routerai' AND id=$2", [account, id(account, request.requestId)])).rows[0]?.data;
      if (previous) {
        if (!matches(previous)) throw Object.assign(new Error('Запрос с этим ID уже имеет другие параметры'), { status: 409 });
        return previous;
      }
      if (nativeQuote.amountUnits !== null) await reserve(db, account, id(account, request.requestId), nativeQuote);
      const createdAt = new Date().toISOString();
      const record = { ...request, id: request.requestId, state: 'running', revision: 1, nativeQuote, createdAt, updatedAt: createdAt };
      await db.query("INSERT INTO media_records(account_id,namespace,id,data) VALUES($1,'routerai',$2,$3)", [account, id(account, request.requestId), JSON.stringify(record)]);
      await appendGenerationEvent(db, account, 'routerai', record, 'created');
      fresh = true;
      return record;
    });
    if (fresh) void process(account, job).catch(() => {});
    return job;
  }
  async function submit(account, raw, role = 'user', allowedModels = catalog.models) {
    return save(account, validateRouterAiRequest(raw, allowedModels), role);
  }
  async function submitAdmin(account, raw, allModels) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !['requestId', 'model', 'payload', 'projectId', 'chatId', 'quotedAmountUnits'].includes(key))) throw invalid('Некорректный запрос RouterAI');
    if (typeof raw.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(raw.requestId)) throw invalid('Некорректный ID запроса');
    for (const [value, label] of [[raw.projectId, 'Проект'], [raw.chatId, 'Чат']]) {
      if (value !== undefined && value !== null && (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value))) throw invalid(`${label} не найден`);
    }
    const model = allModels.find(item => item.id === raw.model);
    if (!model) throw invalid('Модель RouterAI недоступна');
    if (!raw.payload || typeof raw.payload !== 'object' || Array.isArray(raw.payload) || 'model' in raw.payload) throw invalid('Некорректное тело запроса RouterAI');
    const serialized = JSON.stringify(raw.payload);
    if (!serialized || serialized.length > 256 * 1024) throw invalid('Тело запроса RouterAI слишком большое');
    const payload = model.kind === 'video' ? { ...raw.payload,
      ...(raw.payload.duration == null && model.supportedDurations?.length ? { duration: model.supportedDurations[0] } : {}),
      ...(raw.payload.resolution == null && model.supportedResolutions?.length ? { resolution: model.supportedResolutions[0] } : {}) } : raw.payload;
    const request = { requestId: raw.requestId, model: model.id, kind: 'api', modelKind: model.kind, endpoint: model.endpoint, payload,
      ...(raw.quotedAmountUnits !== undefined ? { quotedAmountUnits: raw.quotedAmountUnits } : {}),
      prompt: `[${model.kind}] ${model.name}`, ...(raw.projectId ? { projectId: raw.projectId } : {}), ...(raw.chatId ? { chatId: raw.chatId } : {}) };
    return save(account, request, 'admin');
  }
  async function adminVideo(account, requestId, contentFile = false) {
    const job = await get(account, requestId);
    if (!job || job.kind !== 'api' || job.endpoint !== 'videos' || !job.providerVideoId) throw Object.assign(new Error('Задача видео не найдена'), { status: 404 });
    return client.video(job.providerVideoId, contentFile);
  }
  return { quote, submit, submitAdmin, adminVideo, get,
    async recover() {
      const rows = (await accounts.pool.query("SELECT account_id,id,data FROM media_records WHERE namespace='routerai' AND data->>'state'='running'")).rows;
      for (const row of rows) await finish(row.account_id, row.data.id, { state: 'unknown', error: row.data.nativeQuote?.amountUnits == null
        ? 'Сервис перезапущен во время запроса RouterAI. Результат требует проверки.'
        : 'Сервис перезапущен во время запроса RouterAI. Резерв сохранён до проверки.' });
    },
    async image(account, requestId) {
      const job = await get(account, requestId);
      if (job?.state !== 'success' || !job.contentAssetId) throw Object.assign(new Error('Изображение не найдено'), { status: 404 });
      return content.file(account, job.contentAssetId);
    } };
}

module.exports = { createRouterAiBilling, validateRouterAiRequest };
