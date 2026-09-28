const { createApimartClient } = require('../providers/apimart/client');
const { safeMessage } = require('../provider-diagnostics');
const { appendGenerationEvent } = require('./generation-journal');
const { transaction } = require('../database/database');

const NAMESPACE = 'apimart';
const MODEL_TTL_MS = 10 * 60 * 1000;
const UUID = /^[a-f0-9-]{36}$/;
const MODEL_ID = /^[a-z0-9][a-z0-9._:/-]{0,159}$/i;
// APIMart labels these legacy base models as chat, but /chat/completions rejects them.
const NON_CHAT_MODELS = new Set(['babbage-002', 'davinci-002']);

function createApimartJobs({ pool, apiKey, fetchImpl, now = Date.now }) {
  const client = createApimartClient({ apiKey, ...(fetchImpl ? { fetchImpl } : {}) });
  let cachedModels = null;
  let expiresAt = 0;
  let pending = null;
  async function models() {
    if (cachedModels && now() < expiresAt) return cachedModels;
    if (!pending) pending = (async () => {
      const response = await client.models();
      if (!Array.isArray(response?.data)) throw new Error('APIMart вернул неверный каталог');
      cachedModels = response.data.filter(item => item?.category === 'chat' && typeof item.id === 'string'
        && MODEL_ID.test(item.id) && !NON_CHAT_MODELS.has(item.id))
        .map(item => ({ id: item.id, name: item.id, kind: 'text' }));
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
  async function process(account, job) {
    try {
      await appendGenerationEvent(pool, account, NAMESPACE, job, 'send_start');
      const response = await client.chat(job.model, job.prompt);
      const output = response?.choices?.[0]?.message?.content;
      if (typeof output !== 'string' || !output.trim() || output.length > 2 * 1024 * 1024) {
        return finish(account, job, 'unknown', { error: 'APIMart вернул пустой или слишком большой ответ. Проверьте расход в кабинете.' });
      }
      return finish(account, job, 'success', { output, usage: response.usage || null });
    } catch (error) {
      const state = error.confirmedRejected ? 'fail' : 'unknown';
      return finish(account, job, state, { error: state === 'fail' ? safeMessage(error.message)
        : 'Исход запроса APIMart неизвестен. Проверьте расход в кабинете перед повтором.' });
    }
  }
  async function submit(account, raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || Object.keys(raw).some(key => !['requestId', 'model', 'prompt', 'projectId', 'chatId'].includes(key))
      || typeof raw.requestId !== 'string' || !UUID.test(raw.requestId)
      || typeof raw.prompt !== 'string' || !raw.prompt.trim() || raw.prompt.length > 20000
      || typeof raw.model !== 'string' || !MODEL_ID.test(raw.model)
      || [raw.projectId, raw.chatId].some(value => value != null && (typeof value !== 'string' || !UUID.test(value)))) {
      throw Object.assign(new Error('Некорректный запрос APIMart'), { status: 400 });
    }
    const existing = await get(account, raw.requestId);
    if (existing) {
      if (existing.model !== raw.model || existing.prompt !== raw.prompt
        || (existing.chatId || null) !== (raw.chatId || null) || (existing.projectId || null) !== (raw.projectId || null)) {
        throw Object.assign(new Error('Запрос с этим ID уже имеет другие параметры'), { status: 409 });
      }
      return existing;
    }
    if (!(await models()).some(item => item.id === raw.model)) throw Object.assign(new Error('Модель APIMart недоступна'), { status: 403 });
    const createdAt = new Date().toISOString();
    const job = { id: raw.requestId, requestId: raw.requestId, model: raw.model, prompt: raw.prompt.trim(), kind: 'text',
      state: 'running', revision: 1, createdAt, updatedAt: createdAt,
      projectId: raw.projectId || null, chatId: raw.chatId || null };
    try {
      await transaction(pool, async db => {
        await db.query("INSERT INTO media_records(account_id,namespace,id,data) VALUES($1,'apimart',$2,$3)",
          [account, recordId(account, raw.requestId), JSON.stringify(job)]);
        await appendGenerationEvent(db, account, NAMESPACE, job, 'created');
      });
    } catch (error) {
      if (error.code === '23505') return get(account, raw.requestId);
      throw error;
    }
    void process(account, job).catch(() => {});
    return job;
  }
  async function recover() {
    const rows = (await pool.query("SELECT account_id,data FROM media_records WHERE namespace='apimart' AND data->>'state'='running'")).rows;
    for (const row of rows) await finish(row.account_id, row.data, 'unknown',
      { error: 'Сервис перезапущен во время запроса APIMart. Проверьте расход в кабинете перед повтором.' });
  }
  return { models, get, submit, recover };
}

module.exports = { createApimartJobs };
