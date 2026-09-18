const { Pool } = require('pg');
const fs = require('node:fs/promises');
const path = require('node:path');
function transientConnection(error) {
  return ['EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', '57P03'].includes(error.code) || /connection timeout|timeout expired|timeout exceeded when trying to connect|Connection terminated/i.test(error.message || '');
}
function retryConnections(pool) {
  const connect = pool.connect.bind(pool);
  pool.connect = function (callback) {
    const acquire = async () => {
      for (let attempt = 0; ; attempt++) {
        try { return await connect(); }
        catch (error) { if (attempt >= 2 || !transientConnection(error)) throw error; }
      }
    };
    const operation = acquire();
    if (!callback) return operation;
    operation.then(client => callback(null, client, client.release), error => callback(error));
  };
  return pool;
}
async function transaction(pool, action) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await action(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}
async function openDatabase(config, suppliedPool) {
  const pool = suppliedPool || retryConnections(new Pool({ connectionString: config.url, ssl: config.ssl ? { rejectUnauthorized: true } : undefined,
    max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 0, keepAlive: true,
    // Hosted PostgreSQL proxies may reject extra startup parameters.
    // Initialize the session after authentication, before handing it to callers.
    onConnect: client => client.query('SET statement_timeout = 15000') }));
  pool.on?.('error', () => console.error('Соединение с БД потеряно'));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await transaction(pool, async client => {
        await client.query('SELECT pg_advisory_xact_lock(18274691)');
        await client.query(await fs.readFile(path.join(__dirname, 'schema.sql'), 'utf8'));
      });
      return pool;
    } catch (error) {
      if (!transientConnection(error) || attempt === 2) { await pool.end(); throw new Error('Не удалось подключить или подготовить БД аккаунтов'); }
      // Only idempotent schema initialization is retried, never paid requests.
      console.error('Database startup retry:', error.code || 'CONNECTION_TIMEOUT');
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
}
async function checkDatabase(pool) {
  if (!pool) return { state: 'disabled' };
  const poolInfo = () => ({ total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount });
  const started = Date.now();
  try {
    const result = await pool.query({ text: "SELECT current_setting('max_connections') AS max_connections, (SELECT count(*) FROM pg_stat_activity) AS sessions, (SELECT rolconnlimit FROM pg_roles WHERE rolname=current_user) AS role_connection_limit, (SELECT count(*) FROM pg_stat_activity WHERE usename=current_user) AS role_sessions", query_timeout: 3000 });
    const row = result.rows[0] || {};
    return { state: 'connected', latencyMs: Date.now() - started, pool: poolInfo(), server: { maxConnections: Number(row.max_connections) || null, sessions: Number(row.sessions) || null, roleConnectionLimit: Number(row.role_connection_limit), roleSessions: Number(row.role_sessions) || null } };
  } catch (error) {
    return { state: 'unavailable', code: error.code || 'CONNECTION_TIMEOUT', pool: poolInfo() };
  }
}
module.exports = { openDatabase, transaction, retryConnections, checkDatabase };
