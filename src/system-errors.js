const { clean } = require('./generation-log');

const maxPending = 500;
let pool = null;
let pending = [];
let draining = null;
let retryTimer = null;
let retentionTimer = null;
let retentionEnabled = false;

function normalize(source, event, error, details = {}) {
  const safe = clean({ error, details });
  const value = safe.error;
  const message = typeof value === 'string' ? value : value?.message || String(value ?? event);
  return {
    source: String(source).slice(0, 100), event: String(event).slice(0, 150),
    code: value?.code == null ? null : String(value.code).slice(0, 100),
    message: String(message).slice(0, 4000), details: safe.details || {},
  };
}

function record(source, event, error, details) {
  try {
    if (pending.length >= maxPending) pending.shift();
    pending.push(normalize(source, event, error, details));
    void flush();
  } catch { /* Error recording must never interrupt the original operation. */ }
}

async function pruneOld(pool, days = 90, limit = 500) {
  const result = await pool.query(`DELETE FROM media_system_errors WHERE id IN (
    SELECT id FROM media_system_errors WHERE occurred_at < now()-($1::int * interval '1 day')
    ORDER BY occurred_at,id LIMIT $2)`, [days, limit]);
  return result.rowCount || 0;
}

function scheduleRetention(delay) {
  if (!pool || !retentionEnabled) return;
  retentionTimer = setTimeout(async () => {
    retentionTimer = null;
    const currentPool = pool;
    let nextDelay = 60 * 60 * 1000;
    try { if (await pruneOld(currentPool) === 500) nextDelay = 1000; }
    catch { nextDelay = 5 * 60 * 1000; }
    if (pool === currentPool) scheduleRetention(nextDelay);
  }, delay);
  retentionTimer.unref?.();
}

function setPool(nextPool, { retention = false } = {}) {
  pool = nextPool;
  retentionEnabled = retention;
  if (retryTimer) clearTimeout(retryTimer);
  if (retentionTimer) clearTimeout(retentionTimer);
  retryTimer = null;
  retentionTimer = null;
  if (pool) void flush();
  if (pool && retentionEnabled) scheduleRetention(30000);
}

function flush() {
  if (draining || !pool || !pending.length) return draining || Promise.resolve();
  draining = (async () => {
    while (pool && pending.length) {
      const row = pending[0];
      try {
        await pool.query('INSERT INTO media_system_errors(source,event,code,message,details) VALUES($1,$2,$3,$4,$5)',
          [row.source, row.event, row.code, row.message, JSON.stringify(row.details)]);
        pending.shift();
      } catch {
        // Preserve the bounded queue until the database is available again.
        retryTimer = setTimeout(() => { retryTimer = null; void flush(); }, 5000);
        retryTimer.unref?.();
        break;
      }
    }
  })().finally(() => { draining = null; });
  return draining;
}

function captureConsole() {
  const original = console.error;
  console.error = (...args) => {
    original.apply(console, args);
    const [first, ...rest] = args;
    const error = rest.find(value => value instanceof Error) || (first instanceof Error ? first : rest.at(-1));
    record('server', 'console.error', error || first, { context: first instanceof Error ? undefined : first });
  };
  return () => { console.error = original; };
}

module.exports = { record, setPool, flush, captureConsole, pruneOld };
