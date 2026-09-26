const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { listenForAccountChanges } = require('../../src/database/change-events');

const root = path.resolve(__dirname, '../..');
const runId = process.argv[2];
if (!/^[a-zA-Z0-9_-]{4,80}$/.test(runId || '')) throw new Error('Usage: notifications.cjs <prepared-run-id>');
const [session] = JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'load-tests', runId, 'sessions.json'), 'utf8'));
const line = fs.readFileSync(path.join(root, '.env.load-test'), 'utf8').split(/\r?\n/)
  .find(value => value.startsWith('LOAD_TEST_DATABASE_URL='));
const target = new URL(line?.slice('LOAD_TEST_DATABASE_URL='.length).trim());
if (target.hostname !== 'node1.pghost.ru' || target.pathname !== '/bothost_db_c5e6aab87bbb')
  throw new Error('Load-test database identity check failed');

async function main() {
  const pool = new Pool({ connectionString: target.toString(), max: 2 });
  let listener;
  try {
    const received = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Account change notification timed out')), 10000);
      listener = listenForAccountChanges(pool, accountId => {
        if (accountId !== session.id) return;
        clearTimeout(timeout); resolve(accountId);
      });
    });
    // Give LISTEN a round trip to finish before changing the record.
    await new Promise(resolve => setTimeout(resolve, 500));
    const result = await pool.query(`UPDATE media_records SET updated_at=now()
      WHERE account_id=$1 AND id=(SELECT id FROM media_records WHERE account_id=$1 LIMIT 1)`, [session.id]);
    if (!result.rowCount) throw new Error('Prepared account has no history fixture');
    await received;
    console.log(JSON.stringify({ runId, notification: 'received', accountScoped: true }));
  } finally { await listener?.close(); await pool.end(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
