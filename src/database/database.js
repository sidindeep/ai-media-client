const { Pool } = require('pg');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const systemErrors = require('../system-errors');
const normalizeSql = sql => sql.replace(/\r\n?/g, '\n');
const sqlHash = sql => createHash('sha256').update(sql).digest('hex');
const migrationChecksum = sql => sqlHash(normalizeSql(sql));
const baselineV10CanonicalHash = '0c2ffc1f6a780051be243168cb3d145de02ff355c54ea6d2af82e9ab49069cb6';
const baselineV10MixedWindowsHash = '579167d62b3350f35b14c05218ff57e3b68fbc038b016054cd9102fa41834553';
function matchesMigrationChecksum(stored, sql, version) {
  const normalized = normalizeSql(sql);
  const canonical = sqlHash(normalized);
  // v10 was first recorded from a mixed-LF/CRLF Windows checkout. Only that
  // exact published baseline may use its historical checksum.
  return stored === canonical || stored === sqlHash(normalized.replace(/\n/g, '\r\n'))
    || (version === 10 && canonical === baselineV10CanonicalHash && stored === baselineV10MixedWindowsHash);
}
const transientConnectionCodes = new Set([
  'EAI_AGAIN', 'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETDOWN', 'ENETUNREACH', 'ENOTFOUND', 'EPIPE', 'ETIMEDOUT',
  'PROTOCOL_CONNECTION_LOST', 'UND_ERR_CONNECT_TIMEOUT', '53300', '57P01', '57P02', '57P03',
]);
function transientConnection(error) {
  const code = String(error?.code || '').toUpperCase();
  return code.startsWith('08') || transientConnectionCodes.has(code)
    || /connection (?:closed|terminated)|connection timeout|server closed the connection|terminating connection|timeout expired|timeout exceeded when trying to connect/i.test(error?.message || '');
}
function retryConnections(pool) {
  const connect = pool.connect.bind(pool);
  const waits = [];
  pool.mediaPoolWait = () => {
    const recent = waits.filter(item => item.at > Date.now() - 60000).map(item => item.ms).sort((a, b) => a - b);
    return { samples: recent.length, p95Ms: recent.length ? recent[Math.ceil(recent.length * 0.95) - 1] : null,
      maxMs: recent.length ? recent[recent.length - 1] : null };
  };
  pool.connect = function (callback) {
    const acquire = async () => {
      for (let attempt = 0; ; attempt++) {
        const started = Date.now();
        try {
          const client = await connect();
          waits.push({ at: Date.now(), ms: Date.now() - started });
          if (waits.length > 5000) waits.splice(0, waits.length - 5000);
          return client;
        }
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
    max: config.poolMax ?? 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 0, keepAlive: true,
    // Hosted PostgreSQL proxies may reject extra startup parameters.
    // Initialize the session after authentication, before handing it to callers.
    onConnect: client => client.query('SET statement_timeout = 15000') }));
  pool.on?.('error', error => systemErrors.record('database', 'connection-lost.error', error));
  const baseline = await fs.readFile(path.join(__dirname, 'schema.sql'), 'utf8');
  const migrationFiles = (await fs.readdir(path.join(__dirname, 'migrations'))).filter(name => /^\d{4}-[a-z0-9-]+\.sql$/.test(name)).sort();
  const migrations = await Promise.all(migrationFiles.map(async name => ({ version: Number(name.slice(0, 4)), sql: await fs.readFile(path.join(__dirname, 'migrations', name), 'utf8') })));
  const latestVersion = migrations.at(-1)?.version || 10;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await transaction(pool, async client => {
        await client.query('SELECT pg_advisory_xact_lock(18274691)');
        const existing = (await client.query("SELECT to_regclass('media_schema_versions') AS name")).rows[0]?.name;
        let version = existing ? Number((await client.query('SELECT COALESCE(max(version),0) AS version FROM media_schema_versions')).rows[0].version) : 0;
        if (version > latestVersion) throw Object.assign(new Error('Версия БД новее версии приложения'), { code: 'DATABASE_VERSION_NEWER' });
        if (version < 10) {
          if (config.migrate === false) throw Object.assign(new Error('Требуется миграция БД'), { code: 'DATABASE_MIGRATION_REQUIRED' });
          await client.query(baseline);
          version = 10;
        }
        const journal = (await client.query("SELECT to_regclass('media_schema_migrations') AS name")).rows[0]?.name;
        if (!journal && config.migrate === false) throw Object.assign(new Error('Требуется журнал миграций БД'), { code: 'DATABASE_MIGRATION_REQUIRED' });
        if (!journal) await client.query(`CREATE TABLE media_schema_migrations (
          version integer PRIMARY KEY, checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'), applied_at timestamptz NOT NULL DEFAULT now())`);
        const applied = (await client.query('SELECT version,checksum FROM media_schema_migrations')).rows;
        const known = new Map(applied.map(row => [Number(row.version), row.checksum]));
        const baselineHash = migrationChecksum(baseline);
        if (known.has(10) && !matchesMigrationChecksum(known.get(10), baseline, 10)) throw Object.assign(new Error('Контрольная сумма базовой схемы изменилась'), { code: 'DATABASE_MIGRATION_CHANGED' });
        if (!known.has(10)) {
          if (config.migrate === false) throw Object.assign(new Error('Базовая схема не зарегистрирована'), { code: 'DATABASE_MIGRATION_REQUIRED' });
          await client.query('INSERT INTO media_schema_migrations(version,checksum) VALUES(10,$1)', [baselineHash]);
        }
        for (const migration of migrations) {
          const hash = migrationChecksum(migration.sql);
          if (known.has(migration.version)) {
            if (!matchesMigrationChecksum(known.get(migration.version), migration.sql, migration.version)) throw Object.assign(new Error(`Миграция ${migration.version} изменена`), { code: 'DATABASE_MIGRATION_CHANGED' });
            continue;
          }
          if (config.migrate === false) throw Object.assign(new Error(`Требуется миграция БД до ${migration.version}`), { code: 'DATABASE_MIGRATION_REQUIRED' });
          await client.query(migration.sql);
          await client.query('INSERT INTO media_schema_versions(version) VALUES($1) ON CONFLICT DO NOTHING', [migration.version]);
          await client.query('INSERT INTO media_schema_migrations(version,checksum) VALUES($1,$2)', [migration.version, hash]);
        }
      });
      return pool;
    } catch (error) {
      if (!transientConnection(error) || attempt === 2) {
        await pool.end();
        throw Object.assign(new Error('Не удалось подключить или подготовить БД аккаунтов'), { code: error.code || 'DATABASE_STARTUP_FAILED', cause: error });
      }
      // Only idempotent schema initialization is retried, never paid requests.
      systemErrors.record('database', 'startup-retry.error', error);
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
}
async function checkDatabase(pool, { diagnostics = true } = {}) {
  if (!pool) return { state: 'disabled' };
  const poolInfo = () => ({ total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount,
    ...(pool.mediaPoolWait ? { acquire60s: pool.mediaPoolWait() } : {}) });
  const started = Date.now();
  try {
    const result = await pool.query({ text: diagnostics
      ? "SELECT current_setting('max_connections') AS max_connections, (SELECT count(*) FROM pg_stat_activity) AS sessions, (SELECT rolconnlimit FROM pg_roles WHERE rolname=current_user) AS role_connection_limit, (SELECT count(*) FROM pg_stat_activity WHERE usename=current_user) AS role_sessions"
      : 'SELECT 1 AS connected', query_timeout: 3000 });
    const row = result.rows[0] || {};
    return { state: 'connected', latencyMs: Date.now() - started, pool: poolInfo(), ...(diagnostics ? { server: { maxConnections: Number(row.max_connections) || null, sessions: Number(row.sessions) || null, roleConnectionLimit: Number(row.role_connection_limit), roleSessions: Number(row.role_sessions) || null } } : {}) };
  } catch (error) {
    return { state: 'unavailable', code: error.code || 'CONNECTION_TIMEOUT', pool: poolInfo() };
  }
}
module.exports = { openDatabase, transaction, retryConnections, checkDatabase, transientConnection };
