const { transaction } = require('../database/database');
const { reserve, settle, lockWallet } = require('../billing/wallet');
const { appendGenerationEvent } = require('../services/generation-journal');
const { createStoredRetry } = require('../services/submission-control');

// Generations owns the Codex namespace. This unit of work joins its records,
// journal and the public wallet transaction operations atomically.
function createCodexRecords({ pool }) {
  const id = (account, requestId) => `codex:${account}:${requestId}`;
  const get = async (account, requestId) => (await pool.query(
    "SELECT data FROM media_records WHERE account_id=$1 AND namespace='codex' AND id=$2",
    [account, id(account, requestId)])).rows[0]?.data;
  return Object.freeze({
    get,
    async update(account, requestId, patch) {
      return transaction(pool, async client => {
        await lockWallet(client, account);
        const row = (await client.query("SELECT data FROM media_records WHERE account_id=$1 AND namespace='codex' AND id=$2 FOR UPDATE",
          [account, id(account, requestId)])).rows[0];
        if (!row) throw Object.assign(new Error('Запрос не найден'), { status: 404 });
        if (['success', 'fail'].includes(row.data.state)) return row.data;
        const now = new Date();
        const next = { ...row.data, ...patch, revision: Number(row.data.revision || 0) + 1, updatedAt: now.toISOString() };
        if (Array.isArray(patch.missingWorkerInstanceIds) && patch.missingWorkerInstanceIds.length) {
          // Merge under the record lock so independent executors retain each other's evidence.
          next.missingWorkerInstanceIds = [...new Set([
            ...(Array.isArray(row.data.missingWorkerInstanceIds) ? row.data.missingWorkerInstanceIds : []),
            ...patch.missingWorkerInstanceIds,
          ])].slice(-8);
        }
        if (['success', 'fail'].includes(next.state) && next.durationMs == null) {
          const started = Date.parse(next.startedAt || next.createdAt);
          if (Number.isFinite(started)) { next.completedAt = now.toISOString(); next.durationMs = Math.max(0, now.getTime() - started); }
        }
        await settle(client, account, id(account, requestId), next.state, next);
        await client.query("UPDATE media_records SET data=$3,updated_at=now() WHERE account_id=$1 AND namespace='codex' AND id=$2",
          [account, id(account, requestId), JSON.stringify(next)]);
        if (row.data.state !== next.state) await appendGenerationEvent(client, account, 'codex', next, next.state, { error: next.error });
        return next;
      });
    },
    async create(account, request, modelName, quote) {
      return transaction(pool, async client => {
        await lockWallet(client, account);
        const previous = (await client.query("SELECT data FROM media_records WHERE account_id=$1 AND namespace='codex' AND id=$2",
          [account, id(account, request.requestId)])).rows[0]?.data;
        if (previous) {
          if (['model', 'effort', 'speed', 'prompt', 'aspectRatio', 'projectId', 'chatId'].some(key => (previous[key] ?? null) !== (request[key] ?? null))
            || JSON.stringify(previous.sourceFiles || []) !== JSON.stringify(request.sourceFiles || [])
            || (previous.kind || 'text') !== (request.kind || 'text')) throw Object.assign(new Error('Запрос с этим ID уже имеет другие параметры'), { status: 409 });
          return { record: previous, fresh: false };
        }
        const nativeQuote = quote(request);
        await reserve(client, account, id(account, request.requestId), nativeQuote);
        const createdAt = new Date().toISOString();
        const record = { ...request, modelName, id: request.requestId, revision: 1, state: 'submitting', stage: 'submitting', nativeQuote,
          createdAt, updatedAt: createdAt, startedAt: createdAt };
        await client.query("INSERT INTO media_records(account_id,namespace,id,data) VALUES($1,'codex',$2,$3)",
          [account, id(account, request.requestId), JSON.stringify(record)]);
        await appendGenerationEvent(client, account, 'codex', record, 'created');
        return { record, fresh: true };
      });
    },
    recordSend: (account, request) => appendGenerationEvent(pool, account, 'codex', request, 'send_start'),
    pending: async () => (await pool.query("SELECT account_id,id,data FROM media_records WHERE namespace='codex' AND data->>'state' IN ('running','submitting','unknown','queued')")).rows,
    createRetry: options => createStoredRetry({ ...options, pool, namespace: 'codex', jobId: id }),
  });
}

module.exports = { createCodexRecords };
