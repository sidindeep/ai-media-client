const { Pool } = require('pg');
const { grantRuntimeRole } = require('../src/database/runtime-grants');

async function main() {
  if (!process.env.DATABASE_MIGRATION_URL || !process.env.MEDIA_RUNTIME_ROLE) throw new Error('Нужны DATABASE_MIGRATION_URL и MEDIA_RUNTIME_ROLE');
  const pool = new Pool({ connectionString: process.env.DATABASE_MIGRATION_URL });
  try { await grantRuntimeRole(pool, process.env.MEDIA_RUNTIME_ROLE); }
  finally { await pool.end(); }
  process.stdout.write('Runtime grants applied. Check the role with a separate connection before switching DATABASE_URL.\n');
}
main().catch(error => { process.stderr.write(`${error.code || error.message}\n`); process.exitCode = 1; });
