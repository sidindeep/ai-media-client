const { validateCodexRequest } = require('./codex-request');
const { validatePng, MAX_IMAGE_BYTES } = require('./codex-images');
const { normalizeUsage } = require('./codex-usage');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { parseContentRef } = require('./content-service');
const { submissionDecision } = require('./submission-control');
const { safeErrorText } = require('./codex-errors');
const priceKey = request => `codex:${request.model}:${request.effort}:${request.speed}`;
function createCodexBilling({ records, worker, pricing, conversion, dataDirectory, storage = null, content = null,
  retryDelayMs = 10_000 }) {
  const timers = new Map(), statusInFlight = new Map(); let closed = false;
  const id = (account, requestId) => `codex:${account}:${requestId}`;
  const get = records.get;
  const quote = request => ({ ...conversion.quote('codex', pricing.quote(priceKey(request))), source: 'configured' });
  const imagePath = (account, requestId) => path.join(dataDirectory, 'codex-images', account, requestId + '.png');
  const imageKey = (account, requestId) => `accounts/${account}/codex-images/${requestId}.png`;
  const update = records.update;
  const models = worker.listModels;
  function watch(account, requestId) {
    const key = id(account, requestId);
    if (closed || timers.has(key)) return;
    const timer = setTimeout(async () => {
      timers.delete(key);
      try { const job = await status(account, requestId); if (['running', 'submitting'].includes(job.state)) watch(account, requestId); }
      catch { if (!closed) watch(account, requestId); }
    }, 1500);
    timer.unref(); timers.set(key, timer);
  }
  async function status(account, requestId) {
    const key = id(account, requestId);
    if (statusInFlight.has(key)) return statusInFlight.get(key);
    const pending = readStatus(account, requestId);
    statusInFlight.set(key, pending);
    try { return await pending; }
    finally { if (statusInFlight.get(key) === pending) statusInFlight.delete(key); }
  }
  async function readStatus(account, requestId) {
    const job = await read(account, requestId);
    if (['success', 'fail', 'queued'].includes(job.state)) return job;
    try {
      const result = await worker.getTask(account, requestId);
      if (result.state === 'success') {
        let contentAssetId = null;
        let contentSaveError = null;
        if (job.kind === 'image') {
          let image;
          try {
            if (result.hasImage === true) image = await worker.getImage(account, requestId);
            else {
              if (typeof result.imageBase64 !== 'string' || result.imageBase64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error('missing image');
              image = validatePng(Buffer.from(result.imageBase64, 'base64'));
            }
          } catch { return await update(account, requestId, { state: 'unknown', error: 'Изображение не получено. Результат требует проверки; резерв сохранён.' }); }
          try { if (content) {
            try {
              const asset = await content.createFromBuffer(account, { bytes: image, name: requestId + '.png', type: 'image/png', origin: { kind: 'result', provider: 'codex', recordId: id(account, requestId), position: 0 } });
              await content.link(account, 'codex', id(account, requestId), asset.id, 'result', 0);
              await content.wait(account, asset.id);
              contentAssetId = asset.id;
            } catch (error) { require('../system-errors').record('provider', 'codex-billing.error', error, { diagnostic: { entity: 'provider' } });
              // Storage catalog errors must not turn a confirmed provider result
              // into an unknown billing outcome. Preserve bytes under the legacy key.
              if (!storage) throw error;
              await storage.put(imageKey(account, requestId), image, 'image/png', image.length);
            }
          } else if (storage) await storage.put(imageKey(account, requestId), image, 'image/png', image.length);
          else {
            const filename = imagePath(account, requestId), temporary = filename + '.' + randomUUID() + '.tmp';
            await fs.mkdir(path.dirname(filename), { recursive: true });
            try { await fs.writeFile(temporary, image, { flag: 'wx' }); await fs.rename(temporary, filename); }
            finally { await fs.unlink(temporary).catch(() => {}); }
          } } catch { contentSaveError = 'Изображение создано, но постоянное сохранение требует повтора.'; }
        }
        const saved = await update(account, requestId, { state: 'success', output: result.output, usage: normalizeUsage(result.usage), hasImage: job.kind === 'image', ...(typeof contentAssetId === 'string' ? { contentAssetId } : {}), ...(contentSaveError ? { contentSaveError } : {}), error: null });
        if (job.kind === 'image' && !contentSaveError && result.hasImage === true)
          await worker.acknowledgeImage(account, requestId).catch(() => {});
        return saved;
      }
      if (result.state === 'failed') return await update(account, requestId, { state: 'fail', error: safeErrorText(result.error) || 'Codex request failed.' });
      if (result.state === 'unknown') return await update(account, requestId, { state: 'unknown', error: safeErrorText(result.error) || 'Codex result is unknown.' });
      return job;
    } catch (error) { require('../system-errors').record('provider', 'codex-billing.error', error, { diagnostic: { entity: 'provider' } });
      // Unknown completion must never release or charge automatically.
      if (error.remoteStatus === 404) return await update(account, requestId, {
        state: 'unknown', error: 'Worker больше не хранит задание. Результат требует проверки; резерв сохранён.'
      });
      return await update(account, requestId, { state: 'unknown', error: 'Статус Codex уточняется. Резерв сохранён. ' + safeErrorText(error.message) });
    }
  }
  async function loadImages(account, request) {
    const images = [];
    for (const ref of request.sourceFiles || []) {
      const contentId = parseContentRef(ref);
      if (contentId) {
        images.push(`data:image/png;base64,${(await content.read(account, contentId)).toString('base64')}`);
        continue;
      }
      const match = /^https:\/\/local-assets\.invalid\/([a-f0-9]{64})$/.exec(ref);
      if (!match) continue;
      let bytes;
      try { bytes = storage ? await storage.read(`accounts/${account}/sources/${match[1]}`) : await fs.readFile(path.join(dataDirectory, 'accounts', account, 'sources', match[1])); }
      catch {
        bytes = await fs.readFile(path.join(dataDirectory, 'accounts', account, 'sources', match[1]))
          .catch(() => { throw Object.assign(new Error('Исходное изображение не найдено'), { status: 400 }); });
      }
      images.push(`data:image/png;base64,${bytes.toString('base64')}`);
    }
    return images;
  }
  async function read(account, requestId) {
    const job = await get(account, requestId);
    if (!job) throw Object.assign(new Error('Запрос не найден'), { status: 404 });
    return job;
  }
  async function send(account, request, images) {
    try {
      await records.recordSend(account, request);
      const { prompt, model, effort, speed, requestId, kind, aspectRatio, sourceFiles, projectId, chatId } = request;
      await worker.submit(account, { prompt, model, effort, speed, requestId, kind, aspectRatio, sourceFiles,
        projectId, chatId, images });
      const running = await update(account, request.requestId, { state: 'running', stage: 'generating', error: null });
      watch(account, request.requestId); return running;
    } catch (error) { require('../system-errors').record('provider', 'codex-billing.error', error, { diagnostic: { entity: 'provider' } });
      const rejected = [400, 403, 413].includes(error.remoteStatus) || error.confirmedRejected === true;
      const decision = submissionDecision({ status: error.remoteStatus, rejected });
      if (decision === 'retry') return retries.defer(account, request.requestId, error);
      return update(account, request.requestId, { state: decision === 'fail' ? 'fail' : 'unknown',
        error: decision === 'fail' ? safeErrorText(error.message) : 'Статус отправки неизвестен. Резерв сохранён; автоматический повтор отключён. ' + safeErrorText(error.message) });
    }
  }
  async function dispatchRetry(account, request) {
    let images;
    try { images = await loadImages(account, request); }
    catch (error) { require('../system-errors').record('provider', 'codex-billing.error', error, { diagnostic: { entity: 'provider' } }); await update(account, request.requestId, { state: 'fail', error: error.message }); return; }
    await send(account, request, images);
  }
  const retries = records.createRetry({
    activeState: 'submitting', activePatch: { stage: 'submitting' }, queuedPatch: { stage: 'queued' },
    retryDelayMs, dispatch: dispatchRetry });
  async function submit(account, raw) {
    const catalog = await models();
    const request = validateCodexRequest(raw, catalog.models);
    const modelName = catalog.models.find(model => model.id === request.model)?.name || request.model;
    const images = await loadImages(account, request);
    const { record: job, fresh } = await records.create(account, request, modelName, quote);
    if (!fresh) return job;
    return send(account, request, images);
  }
  return { quote, models, submit, status, read,
    async image(account, requestId) {
      const job = await get(account, requestId);
      if (!job?.hasImage || job.state !== 'success') throw Object.assign(new Error('Изображение не найдено'), { status: 404 });
      if (job.contentAssetId && content) return content.file(account, job.contentAssetId);
      if (storage && await storage.head(imageKey(account, requestId)).then(() => true).catch(() => false)) return { storageKey: imageKey(account, requestId), name: requestId + '.png', type: 'image/png' };
      return imagePath(account, requestId);
    },
    async recover() {
      const rows = await records.pending();
      for (const row of rows) {
        if (row.data.state === 'queued') { retries.recover(row.account_id, row.data); continue; }
        const current = await status(row.account_id, row.data.id);
        if (['running', 'submitting'].includes(current.state)) watch(row.account_id, row.data.id);
      }
    },
    close() { closed = true; retries.close(); for (const timer of timers.values()) clearTimeout(timer); timers.clear(); }
  };
}
module.exports = { createCodexBilling, priceKey };
