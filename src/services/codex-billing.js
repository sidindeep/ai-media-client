const { transaction } = require('../database/database');
const { reserve, settle, lockWallet } = require('../billing/wallet');
const { validateCodexRequest } = require('./codex-request');
const { validatePng, MAX_IMAGE_BYTES } = require('./codex-images');
const { normalizeUsage } = require('./codex-usage');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const priceKey = request => `codex:${request.model}:${request.effort}:${request.speed}`;
function createCodexBilling({ accounts, url, dataDirectory, fetchImpl = fetch }) {
  const timers = new Map(); let closed = false;
  const id = (account, requestId) => `codex:${account}:${requestId}`;
  const get = async (account, requestId) => (await accounts.pool.query("SELECT data FROM media_records WHERE account_id=$1 AND namespace='codex' AND id=$2", [account, id(account, requestId)])).rows[0]?.data;
  const quote = request => accounts.pricing.quote(priceKey(request));
  const imagePath = (account, requestId) => path.join(dataDirectory, 'codex-images', account, requestId + '.png');
  async function update(account, requestId, patch) {
    return transaction(accounts.pool, async client => {
      await lockWallet(client, account);
      const row = (await client.query("SELECT data FROM media_records WHERE account_id=$1 AND namespace='codex' AND id=$2 FOR UPDATE", [account, id(account, requestId)])).rows[0];
      if (!row) throw Object.assign(new Error('Запрос не найден'), { status: 404 });
      if (['success', 'fail'].includes(row.data.state)) return row.data;
      const now = new Date();
      const next = { ...row.data, ...patch, updatedAt: now.toISOString() };
      if (['success', 'fail'].includes(next.state) && next.durationMs == null) {
        const started = Date.parse(next.startedAt || next.createdAt);
        if (Number.isFinite(started)) {
          next.completedAt = now.toISOString();
          next.durationMs = Math.max(0, now.getTime() - started);
        }
      }
      await settle(client, account, id(account, requestId), next.state);
      await client.query("UPDATE media_records SET data=$3,updated_at=now() WHERE account_id=$1 AND namespace='codex' AND id=$2", [account, id(account, requestId), JSON.stringify(next)]);
      return next;
    });
  }
  async function remote(account, pathname, body) {
    const response = await fetchImpl(url + pathname, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Account-Id': account }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    // A reverse proxy can return concatenated JSON or an HTML/plain-text error.
    // Keep the original status and classify it as an unknown submission instead
    // of leaking JSON.parse's misleading syntax error to the user.
    let value;
    if (typeof response.text === 'function') {
      const text = await response.text();
      try { value = JSON.parse(text); }
      catch { throw Object.assign(new Error(`Codex вернул некорректный ответ (HTTP ${response.status})`), { remoteStatus: response.status }); }
    } else {
      try { value = await response.json(); }
      catch { throw Object.assign(new Error(`Codex вернул некорректный ответ (HTTP ${response.status})`), { remoteStatus: response.status }); }
    }
    if (!response.ok) throw Object.assign(new Error(value.error || 'Codex недоступен'), { remoteStatus: response.status });
    return value;
  }
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
    const job = await get(account, requestId);
    if (!job) throw Object.assign(new Error('Запрос не найден'), { status: 404 });
    if (['success', 'fail'].includes(job.state)) return job;
    try {
      const result = await remote(account, '/jobs/' + requestId);
      if (result.state === 'success') {
        if (job.kind === 'image') {
          let image;
          try {
            if (typeof result.imageBase64 !== 'string' || result.imageBase64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error('missing image');
            image = validatePng(Buffer.from(result.imageBase64, 'base64'));
          } catch { return await update(account, requestId, { state: 'fail', error: 'Изображение не получено. Резерв кредитов возвращён.' }); }
          const filename = imagePath(account, requestId), temporary = filename + '.' + randomUUID() + '.tmp';
          await fs.mkdir(path.dirname(filename), { recursive: true });
          try { await fs.writeFile(temporary, image, { flag: 'wx' }); await fs.rename(temporary, filename); }
          finally { await fs.unlink(temporary).catch(() => {}); }
        }
        return await update(account, requestId, { state: 'success', output: result.output, usage: normalizeUsage(result.usage), hasImage: job.kind === 'image', error: null });
      }
      if (result.state === 'failed') return await update(account, requestId, { state: 'fail', error: result.error });
      if (result.state === 'unknown') return await update(account, requestId, { state: 'unknown', error: result.error });
      return job;
    } catch (error) {
      // Unknown completion must never release or charge automatically.
      if (error.remoteStatus === 404) {
        return await update(account, requestId, {
          state: 'cancelled', stage: 'cancelled',
          error: 'Генерация отменена: worker больше не хранит это задание. Резерв возвращён.'
        });
      }
      return await update(account, requestId, { state: 'unknown', error: 'Статус Codex уточняется. Резерв сохранён; проверьте позже или обратитесь в поддержку.' });
    }
  }
  async function submit(account, raw) {
    const request = validateCodexRequest(raw);
    let fresh = false;
    const job = await transaction(accounts.pool, async client => {
      await lockWallet(client, account);
      const previous = (await client.query("SELECT data FROM media_records WHERE account_id=$1 AND namespace='codex' AND id=$2", [account, id(account, request.requestId)])).rows[0]?.data;
      if (previous) {
        if (['model', 'effort', 'speed', 'prompt'].some(key => previous[key] !== request[key]) || (previous.kind || 'text') !== (request.kind || 'text')) throw Object.assign(new Error('Запрос с этим ID уже имеет другие параметры'), { status: 409 });
        return previous;
      }
      const nativeQuote = quote(request);
      await reserve(client, account, id(account, request.requestId), nativeQuote);
      const createdAt = new Date().toISOString();
      const record = { ...request, id: request.requestId, state: 'submitting', stage: 'submitting', nativeQuote, createdAt, startedAt: createdAt };
      await client.query("INSERT INTO media_records(account_id,namespace,id,data) VALUES($1,'codex',$2,$3)", [account, id(account, request.requestId), JSON.stringify(record)]);
      fresh = true; return record;
    });
    if (!fresh) return job;
    try {
      await remote(account, '/jobs', request);
      const running = await update(account, request.requestId, { state: 'running', stage: 'generating' });
      watch(account, request.requestId); return running;
    } catch (error) {
      const rejected = [400, 403, 413, 429].includes(error.remoteStatus);
      return update(account, request.requestId, { state: rejected ? 'fail' : 'unknown', error: rejected ? error.message : 'Статус отправки неизвестен. Резерв сохранён; автоматический повтор отключён.' });
    }
  }
  return { quote, submit, status,
    async image(account, requestId) {
      const job = await get(account, requestId);
      if (!job?.hasImage || job.state !== 'success') throw Object.assign(new Error('Изображение не найдено'), { status: 404 });
      return imagePath(account, requestId);
    },
    async recover() {
      const rows = (await accounts.pool.query("SELECT account_id,id,data FROM media_records WHERE namespace='codex' AND data->>'state' IN ('running','submitting','unknown')")).rows;
      for (const row of rows) {
        await transaction(accounts.pool, async client => {
          await lockWallet(client, row.account_id);
          const current = (await client.query("SELECT data FROM media_records WHERE account_id=$1 AND namespace='codex' AND id=$2 FOR UPDATE", [row.account_id, row.id])).rows[0];
          if (!current || !['running', 'submitting', 'unknown'].includes(current.data.state)) return;
          const now = new Date();
          const started = Date.parse(current.data.startedAt || current.data.createdAt);
          const next = { ...current.data, state: 'cancelled', stage: 'cancelled', error: 'Генерация отменена при обновлении сервиса. Резерв возвращён.', completedAt: now.toISOString(), updatedAt: now.toISOString() };
          if (Number.isFinite(started)) next.durationMs = Math.max(0, now.getTime() - started);
          await settle(client, row.account_id, row.id, 'cancelled');
          await client.query("UPDATE media_records SET data=$3,updated_at=now() WHERE account_id=$1 AND namespace='codex' AND id=$2", [row.account_id, row.id, JSON.stringify(next)]);
        });
      }
    },
    close() { closed = true; for (const timer of timers.values()) clearTimeout(timer); timers.clear(); }
  };
}
module.exports = { createCodexBilling, priceKey };
