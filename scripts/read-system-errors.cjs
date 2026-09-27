const { Pool } = require('pg');
const { loadConfig } = require('../src/server/config');

async function main() {
  const rawLimit = process.argv[2] || '50';
  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Limit must be an integer from 1 to 200');
  const { database } = loadConfig(process.env);
  if (!database.url) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: database.url, ssl: database.ssl ? { rejectUnauthorized: true } : undefined });
  try {
    const result = await pool.query(`SELECT id,occurred_at,source,event,code,message,details
      FROM media_system_errors ORDER BY occurred_at DESC,id DESC LIMIT $1`, [limit]);
    process.stdout.write(`${JSON.stringify(result.rows, null, 2)}\n`);
  } finally { await pool.end(); }
}

main().catch(error => { process.stderr.write(`${error.code || error.message}\n`); process.exitCode = 1; });
