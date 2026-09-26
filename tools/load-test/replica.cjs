const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { Client } = require('pg');

const root = path.resolve(__dirname, '../..');
const runId = process.argv[2];
if (!/^[a-zA-Z0-9_-]{4,80}$/.test(runId || '')) throw new Error('Usage: replica.cjs <prepared-run-id>');
const directory = path.join(root, 'artifacts', 'load-tests', runId);
const [session] = JSON.parse(fs.readFileSync(path.join(directory, 'sessions.json'), 'utf8'));
const line = fs.readFileSync(path.join(root, '.env.load-test'), 'utf8').split(/\r?\n/)
  .find(value => value.startsWith('LOAD_TEST_DATABASE_URL='));
const target = new URL(line?.slice('LOAD_TEST_DATABASE_URL='.length).trim());
if (target.hostname !== 'node1.pghost.ru' || target.pathname !== '/bothost_db_c5e6aab87bbb')
  throw new Error('Load-test database identity check failed');

function events() {
  return new Promise((resolve, reject) => {
    const request = http.get('http://127.0.0.1:3002/api/events', { headers: { Cookie: session.cookie } }, response => {
      if (response.statusCode !== 200) { request.destroy(); reject(new Error(`Web SSE: ${response.statusCode}`)); return; }
      let data = '';
      let started;
      const changed = new Promise((done, fail) => {
        const timeout = setTimeout(() => fail(new Error('Cross-replica event missing')), 15000);
        response.on('data', chunk => {
          data += chunk.toString();
          if (data.includes('data: changed') || data.includes('data: reset')) { clearTimeout(timeout); done(); }
          if (data.length > 4096) data = data.slice(-1024);
        });
        response.on('error', fail);
      });
      started = { request, changed };
      resolve(started);
    });
    request.on('error', reject);
    request.setTimeout(10000, () => request.destroy(new Error('Web SSE setup timed out')));
  });
}
async function main() {
  const health = await Promise.all([3001, 3002].map(async port => {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    if (!response.ok) throw new Error(`Port ${port} unhealthy: ${response.status}`);
    return response.json();
  }));
  if (health[0].runtime.replicaRole !== 'executor' || health[1].runtime.replicaRole !== 'web')
    throw new Error('Replica roles are wrong');
  const sync = await fetch('http://127.0.0.1:3002/api/workspace/sync', { headers: { Cookie: session.cookie } });
  if (!sync.ok || !(await sync.json()).result?.records) throw new Error('Web replica did not read history');
  const stream = await events();
  const requestId = `load:${runId}:0`;
  const body = [{ requestId, modelId: 'kie:grok-imagine-video-1-5-preview',
    input: { prompt: `Mock load ${requestId}`, duration: 8, aspect_ratio: '16:9', resolution: '720p' }, sourceFiles: [] }];
  const response = await fetch('http://127.0.0.1:3002/api/rpc/createTask', { method: 'POST',
    headers: { Cookie: session.cookie, 'X-Media-Client': 'web', 'X-Media-User': session.id,
      Origin: 'http://127.0.0.1:3002', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const payload = await response.json();
  if (!response.ok || !payload.result?.id) throw new Error(`Web submission failed: ${response.status} ${JSON.stringify(payload)}`);
  try { await stream.changed; } finally { stream.request.destroy(); }
  const db = new Client({ connectionString: target.toString(), connectionTimeoutMillis: 10000 });
  await db.connect();
  try {
    let row;
    for (let attempt = 0; attempt < 80; attempt++) {
      row = (await db.query("SELECT data FROM media_records WHERE account_id=$1 AND namespace='history' AND data->>'requestId'=$2", [session.id, requestId])).rows[0]?.data;
      if (row?.state === 'success') break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (row?.state !== 'success') throw new Error(`Executor did not finish task: ${row?.state}`);
    const submissions = Number((await db.query('SELECT count(*) AS count FROM media_kie_submissions WHERE account_id=$1 AND job_id=$2', [session.id, row.id])).rows[0].count);
    if (submissions !== 1) throw new Error(`Expected one provider submission, got ${submissions}`);
    const result = { requestId, taskId: row.id, finalState: row.state, submissions, crossReplicaEvent: true };
    fs.writeFileSync(path.join(directory, 'replica.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally { await db.end(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
