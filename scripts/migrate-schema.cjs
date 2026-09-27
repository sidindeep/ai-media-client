const { loadConfig } = require('../src/server/config');
const { openDatabase } = require('../src/database/database');

async function main() {
  const config = loadConfig(process.env);
  const pool = await openDatabase({ ...config.database, url: process.env.DATABASE_MIGRATION_URL || config.database.url, migrate: true });
  try {
    const version = (await pool.query('SELECT max(version) AS version FROM media_schema_versions')).rows[0].version;
    process.stdout.write(`Database schema version: ${version}\n`);
  } finally { await pool.end(); }
}
main().catch(error => { process.stderr.write(`${error.code || error.message}\n`); process.exitCode = 1; });
