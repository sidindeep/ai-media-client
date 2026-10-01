const { transaction } = require('../database/database');
const { reserve, settle, lockWallet } = require('../billing/wallet');
const { appendGenerationEvent } = require('../services/generation-journal');
const { createStoredRetry } = require('../services/submission-control');

// Owns RouterAI records and their atomic wallet/journal unit of work.
function createRouterAiRecords({ pool }) {
  const id = (account, requestId) => `routerai:${account}:${requestId}`;
  async function get(account, requestId) {
    return (await pool.query("SELECT data FROM media_records WHERE account_id=$1 AND namespace='routerai' AND id=$2", [account, id(account, requestId)])).rows[0]?.data;
  }
  async function markVideo(account, request, providerVideoId) {
    await transaction(pool, async db => {
      await db.query("UPDATE media_records SET data=jsonb_set(data,'{providerVideoId}',to_jsonb($3::text)),updated_at=now() WHERE account_id=$1 AND namespace='routerai' AND id=$2", [account, id(account, request.requestId), providerVideoId]);
      await appendGenerationEvent(db, account, 'routerai', request, 'accepted', { providerTaskId: providerVideoId });
    });
  }
  async function finish(account, requestId, patch) {
    return transaction(pool, async db => {
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

  async function create(account, request, nativeQuote, matches) {
    let fresh = false;
    const job = await transaction(pool, async db => {
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

    return { record: job, fresh };
  }
  return Object.freeze({ id, get, markVideo, finish, create,
    recordSend: (account, request) => appendGenerationEvent(pool, account, 'routerai', request, 'send_start'),
    pending: async () => (await pool.query("SELECT account_id,id,data FROM media_records WHERE namespace='routerai' AND data->>'state' IN ('running','queued')")).rows,
    createRetry: options => createStoredRetry({ ...options, pool, namespace: 'routerai', jobId: id, activeState: 'running' }),
  });
}
module.exports = { createRouterAiRecords };
