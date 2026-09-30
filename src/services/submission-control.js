// Provider adapters supply evidence about a POST; this module owns the common
// retry decision. A lost response is never evidence that a paid POST was rejected.
const { transaction } = require('../database/database');
const { lockWallet } = require('../billing/wallet');
const { appendGenerationEvent } = require('./generation-journal');
function submissionDecision({ status, rejected = false, accepted = false } = {}) {
  if (accepted) return 'unknown';
  if (rejected && Number(status) === 429) return 'retry';
  if (rejected) return 'fail';
  return 'unknown';
}

function retryAfterAt(attempt = 1, { now = Date.now(), baseMs = 10_000, maxMs = 60_000, minimumMs = 0 } = {}) {
  const exponent = Math.max(0, Math.min(20, Number(attempt) - 1 || 0));
  const backoff = Math.min(maxMs, baseMs * 2 ** exponent);
  const jitter = Math.floor(Math.random() * backoff * 0.2);
  return new Date(now + Math.max(minimumMs, Math.min(maxMs, backoff + jitter))).toISOString();
}

function createRetryScheduler(run, { now = Date.now } = {}) {
  const timers = new Map();
  let closed = false;
  function schedule(key, at) {
    if (closed) return;
    clearTimeout(timers.get(key));
    const delay = Math.max(0, Date.parse(at) - now());
    const timer = setTimeout(() => {
      timers.delete(key);
      if (!closed) Promise.resolve().then(() => run(key)).catch(error => {
        console.error('Delayed submission failed:', error);
        if (!closed) schedule(key, new Date(now() + 10_000).toISOString());
      });
    }, delay);
    timer.unref?.();
    timers.set(key, timer);
  }
  return { schedule, close() { closed = true; for (const timer of timers.values()) clearTimeout(timer); timers.clear(); } };
}

// A retry is a persisted state transition. The timer is only a wake-up hint;
// restart recovery can recreate it from media_records without a second reserve.
function createStoredRetry({ pool, namespace, jobId, activeState, activePatch = {}, queuedPatch = {},
  retryDelayMs = 10_000, dispatch }) {
  const key = (account, requestId) => `${account}:${requestId}`;
  const rowId = (account, requestId) => jobId(account, requestId);
  async function lockedRecord(db, account, requestId) {
    await lockWallet(db, account);
    return (await db.query('SELECT data FROM media_records WHERE account_id=$1 AND namespace=$2 AND id=$3 FOR UPDATE',
      [account, namespace, rowId(account, requestId)])).rows[0]?.data;
  }
  async function save(db, account, requestId, record) {
    await db.query('UPDATE media_records SET data=$4,updated_at=now() WHERE account_id=$1 AND namespace=$2 AND id=$3',
      [account, namespace, rowId(account, requestId), JSON.stringify(record)]);
  }
  const scheduler = createRetryScheduler(async value => {
    const [account, requestId] = value.split(':');
    const record = await transaction(pool, async db => {
      const old = await lockedRecord(db, account, requestId);
      if (old?.state !== 'queued') return null;
      if (Date.parse(old.retryAfterAt) > Date.now()) { scheduler.schedule(value, old.retryAfterAt); return null; }
      const next = { ...old, ...activePatch, state: activeState, retryAfterAt: null, error: null,
        revision: Number(old.revision || 0) + 1, updatedAt: new Date().toISOString() };
      await save(db, account, requestId, next);
      return next;
    });
    if (record) await dispatch(account, record);
  });
  return {
    async defer(account, requestId, error) {
      const queued = await transaction(pool, async db => {
        const old = await lockedRecord(db, account, requestId);
        if (old?.state !== activeState) return old;
        const retryCount = Number(old.retryCount || 0) + 1;
        const next = { ...old, ...queuedPatch, state: 'queued', retryCount,
          retryAfterAt: retryAfterAt(retryCount, { baseMs: retryDelayMs, minimumMs: error.retryAfterMs || 0 }), error: error.message,
          revision: Number(old.revision || 0) + 1, updatedAt: new Date().toISOString() };
        await save(db, account, requestId, next);
        await appendGenerationEvent(db, account, namespace, next, 'queued');
        return next;
      });
      if (queued?.state === 'queued') scheduler.schedule(key(account, requestId), queued.retryAfterAt);
      return queued;
    },
    recover(account, record) { if (record.state === 'queued') scheduler.schedule(key(account, record.id), record.retryAfterAt); },
    close: () => scheduler.close(),
  };
}

module.exports = { submissionDecision, retryAfterAt, createStoredRetry };
