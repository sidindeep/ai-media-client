const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const root = path.resolve(__dirname, '../..');
const line = fs.readFileSync(path.join(root, '.env.load-test'), 'utf8').split(/\r?\n/)
  .find(value => value.startsWith('LOAD_TEST_DATABASE_URL='));
const target = new URL(line?.slice('LOAD_TEST_DATABASE_URL='.length).trim());
if (target.hostname !== 'node1.pghost.ru' || target.pathname !== '/bothost_db_c5e6aab87bbb')
  throw new Error('Load-test database identity check failed');

async function main() {
  const first = new Client({ connectionString: target.toString(), connectionTimeoutMillis: 10000 });
  const second = new Client({ connectionString: target.toString(), connectionTimeoutMillis: 10000 });
  await Promise.all([first.connect(), second.connect()]);
  try {
    const acquire = async client => (await client.query('SELECT pg_try_advisory_lock(18274693) AS acquired')).rows[0].acquired;
    if (!await acquire(first)) throw new Error('First executor could not acquire ownership');
    if (await acquire(second)) throw new Error('Second executor acquired ownership concurrently');
    await first.query('SELECT pg_advisory_unlock(18274693)');
    if (!await acquire(second)) throw new Error('Standby executor did not acquire released ownership');
    console.log(JSON.stringify({ firstOwner: true, concurrentOwnerRejected: true, takeoverAfterRelease: true }));
  } finally {
    await Promise.allSettled([first.end(), second.end()]);
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
