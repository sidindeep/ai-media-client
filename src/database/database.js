const { Pool } = require('pg');
const fs = require('node:fs/promises');
const path = require('node:path');
async function transaction(pool, action) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await action(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}
async function openDatabase(config, suppliedPool) {
  const pool = suppliedPool || new Pool({ connectionString: config.url, ssl: config.ssl ? { rejectUnauthorized: true } : undefined,
    max: 10, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000, statement_timeout: 15000 });
  pool.on?.('error', () => console.error('Соединение с БД потеряно'));
  try {
    await transaction(pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(18274691)');
      await client.query(await fs.readFile(path.join(__dirname, 'schema.sql'), 'utf8'));
    });
    return pool;
  } catch { await pool.end(); throw new Error('Не удалось подключить или подготовить БД аккаунтов'); }
}
module.exports = { openDatabase, transaction };
