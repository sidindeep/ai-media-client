const { Pool } = require('pg');
const { operationsMetrics } = require('../src/services/operations-metrics');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL не задан');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === '1' ? { rejectUnauthorized: true } : undefined,
    max: 2, connectionTimeoutMillis: 5000 });
  try {
    const metrics = await operationsMetrics(pool);
    console.log(JSON.stringify({ checkedAt: new Date().toISOString(), alerts: metrics.alerts, metrics }));
    if (metrics.alerts.length) process.exitCode = 2;
  } finally { await pool.end(); }
}

main().catch(error => {
  console.error(JSON.stringify({ error: error.code || 'OPERATIONS_CHECK_FAILED' }));
  process.exitCode = 3;
});
