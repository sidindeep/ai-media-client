const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Client } = require('pg');

const root = path.resolve(__dirname, '../..');
const runId = process.argv[2];
if (!/^[a-zA-Z0-9_-]{4,80}$/.test(runId || '')) throw new Error('Usage: sse-revoke.cjs <prepared-run-id>');
const [session] = JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'load-tests', runId, 'sessions.json'), 'utf8'));
const line = fs.readFileSync(path.join(root, '.env.load-test'), 'utf8').split(/\r?\n/)
  .find(value => value.startsWith('LOAD_TEST_DATABASE_URL='));
const target = new URL(line?.slice('LOAD_TEST_DATABASE_URL='.length).trim());
if (target.hostname !== 'node1.pghost.ru' || target.pathname !== '/bothost_db_c5e6aab87bbb')
  throw new Error('Load-test database identity check failed');

function connect() {
  return new Promise((resolve, reject) => {
    const request = http.get('http://127.0.0.1:3001/api/events', { headers: { Cookie: session.cookie } }, response => {
      response.resume(); resolve({ request, response });
    });
    request.on('error', reject);
  });
}
async function main() {
  const { request, response } = await connect();
  if (response.statusCode !== 200) throw new Error(`Initial SSE: ${response.statusCode}`);
  const closed = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Revoked SSE remained open')), 22000);
    response.once('close', () => { clearTimeout(timeout); resolve(); });
  });
  const raw = session.cookie.split('=')[1];
  const db = new Client({ connectionString: target.toString(), connectionTimeoutMillis: 10000 });
  try {
    await db.connect();
    const result = await db.query('DELETE FROM media_sessions WHERE account_id=$1 AND token_hash=$2',
      [session.id, createHash('sha256').update(raw).digest('hex')]);
    if (result.rowCount !== 1) throw new Error('Prepared session was not found');
    await closed;
    const again = await connect();
    again.request.destroy();
    if (again.response.statusCode === 200) throw new Error('Revoked session reconnected');
    console.log(JSON.stringify({ runId, revokedStreamClosed: true, reconnectStatus: again.response.statusCode }));
  } finally { request.destroy(); await db.end(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
