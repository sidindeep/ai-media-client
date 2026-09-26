const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { Client, Pool } = require('pg');
const { ensureDefaultChatRow } = require('../../src/services/workspaces');
const { createWallet } = require('../../src/billing/wallet');

const root = path.resolve(__dirname, '../..');
const expectedDatabase = 'bothost_db_c5e6aab87bbb';
const runId = process.argv[2];
const count = Number(process.argv[3] || 25);
const creditUnits = Number(process.argv[4] || 0);
if (!/^[a-zA-Z0-9_-]{4,80}$/.test(runId || '') || !Number.isInteger(count) || count < 1 || count > 100
  || !Number.isSafeInteger(creditUnits) || creditUnits < 0 || creditUnits > 1000000) {
  throw new Error('Usage: node tools/load-test/prepare.cjs <run-id> [users: 1..100] [credit-units: 0..1000000]');
}
function envValue(file, name) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .find(line => line.startsWith(`${name}=`))?.slice(name.length + 1).trim() || '';
}
const url = envValue(path.join(root, '.env.load-test'), 'LOAD_TEST_DATABASE_URL');
const current = envValue(path.join(root, '.env'), 'DATABASE_URL');
let target, production;
try { target = new URL(url); production = current ? new URL(current) : null; }
catch { throw new Error('Load-test database URL is invalid'); }
if (target.pathname.slice(1) !== expectedDatabase || target.hostname !== 'node1.pghost.ru'
  || (production && production.hostname === target.hostname && production.pathname === target.pathname)) {
  throw new Error('Load-test database identity check failed');
}
const output = path.join(root, 'artifacts', 'load-tests', runId, 'sessions.json');
const idFor = index => {
  const hex = createHash('sha256').update(`ai-media-load-test:${expectedDatabase}:${runId}:${index}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

async function main() {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 10000 });
  await client.connect();
  try {
    const identity = (await client.query('SELECT current_database() AS name, to_regclass(\'public.media_sessions\') AS sessions')).rows[0];
    if (identity.name !== expectedDatabase || !identity.sessions) throw new Error('Test schema is unavailable');
    const sessions = [];
    await client.query('BEGIN');
    if (creditUnits) {
      await client.query("INSERT INTO media_accounts(id,display_name,role) VALUES($1,'Load test grant actor','admin') ON CONFLICT(id) DO NOTHING", [idFor(0)]);
      await client.query('INSERT INTO media_wallets(account_id,balance) VALUES($1,0) ON CONFLICT(account_id) DO NOTHING', [idFor(0)]);
    }
    for (let index = 1; index <= count; index++) {
      const id = idFor(index);
      const raw = randomBytes(32).toString('base64url');
      const tokenHash = createHash('sha256').update(raw).digest('hex');
      await client.query('INSERT INTO media_accounts(id,display_name,role) VALUES($1,$2,\'user\') ON CONFLICT(id) DO NOTHING', [id, `Load test ${index}`]);
      await client.query('INSERT INTO media_wallets(account_id,balance) VALUES($1,0) ON CONFLICT(account_id) DO NOTHING', [id]);
      await ensureDefaultChatRow(client, id);
      await client.query('DELETE FROM media_sessions WHERE account_id=$1', [id]);
      await client.query("INSERT INTO media_sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '2 hours')", [tokenHash, id]);
      sessions.push({ id, cookie: `media-session=${raw}` });
    }
    await client.query('COMMIT');
    if (creditUnits) {
      const pool = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 10000 });
      try {
        const wallet = createWallet(pool);
        for (const user of sessions) await wallet.grant(idFor(0), user.id, creditUnits, `load-${runId}`, 'Load test internal credits');
      } finally { await pool.end(); }
    }
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(sessions), { mode: 0o600 });
    console.log(JSON.stringify({ database: identity.name, users: sessions.length, creditUnits, sessionsFile: output }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { await client.end(); }
}
main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
