// B05 fixture and end-to-end page walk against the isolated, free load-test Compose.
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const root = path.resolve(__dirname, '../..');
const runId = process.argv[2], count = Number(process.argv[3]);
if (!/^[a-zA-Z0-9_-]{4,80}$/.test(runId || '') || !Number.isInteger(count) || count < 0 || count > 10000)
  throw new Error('Usage: node tools/load-test/history.cjs <prepared-run-id> <0..10000>');
const directory = path.join(root, 'artifacts', 'load-tests', runId);
const [session] = JSON.parse(fs.readFileSync(path.join(directory, 'sessions.json'), 'utf8'));
if (!session?.id || !session?.cookie) throw new Error('Prepared test session is missing');
const line = fs.readFileSync(path.join(root, '.env.load-test'), 'utf8').split(/\r?\n/)
  .find(value => value.startsWith('LOAD_TEST_DATABASE_URL='));
const databaseUrl = line?.slice('LOAD_TEST_DATABASE_URL='.length).trim();
const target = new URL(databaseUrl);
if (target.hostname !== 'node1.pghost.ru' || target.pathname !== '/bothost_db_c5e6aab87bbb')
  throw new Error('Load-test database identity check failed');

async function request(url) {
  const started = performance.now();
  const response = await fetch(url, { headers: { Cookie: session.cookie } });
  const raw = await response.text();
  if (!response.ok) throw new Error(`History request failed: ${response.status}`);
  const body = JSON.parse(raw);
  return { data: body.result ?? body, ms: performance.now() - started, bytes: Buffer.byteLength(raw) };
}
async function main() {
  const db = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10000 });
  await db.connect();
  let sqlPlan;
  try {
    const identity = (await db.query('SELECT current_database() AS name')).rows[0]?.name;
    if (identity !== 'bothost_db_c5e6aab87bbb') throw new Error('Wrong database');
    const records = Array.from({ length: count }, (_, index) => {
      const id = `fixture:${runId}:${index}`;
      const namespace = ['history', 'codex', 'routerai'][index % 3];
      return { id, namespace, data: { id, state: 'success', model: 'fixture', modelId: 'fixture',
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        resultJson: '{"resultUrls":[]}', input: { prompt: `History fixture ${index}` } } };
    });
    if (records.length) await db.query(`INSERT INTO media_records(account_id,namespace,id,data)
      SELECT $1,namespace,id,data FROM jsonb_to_recordset($2::jsonb) AS item(namespace text,id text,data jsonb)
      ON CONFLICT(account_id,namespace,id) DO NOTHING`, [session.id, JSON.stringify(records)]);
    const explained = await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT namespace,id,data FROM media_records WHERE account_id=$1 AND namespace IN ('history','codex','routerai')
      AND COALESCE(data->>'state','')<>ALL($2::text[])
      ORDER BY COALESCE(data->>'createdAt','') DESC,namespace DESC,id DESC LIMIT 51`,
    [session.id, ['queued','preparing','submitting','waiting','queuing','generating','running']]);
    const plan = explained.rows[0]['QUERY PLAN'][0];
    sqlPlan = { executionMs: plan['Execution Time'], topNode: plan.Plan['Node Type'],
      index: plan.Plan.Plans?.[0]?.['Index Name'] || plan.Plan['Index Name'] || null,
      sharedHitBlocks: plan.Plan['Shared Hit Blocks'], sharedReadBlocks: plan.Plan['Shared Read Blocks'] };
  } finally { await db.end(); }
  const healthBefore = await request('http://127.0.0.1:3001/api/health');
  const full = await request('http://127.0.0.1:3001/api/workspace/sync');
  const seen = new Set(full.data.records.map(item => item.id));
  const pages = [{ ms: full.ms, bytes: full.bytes, records: full.data.records.length }];
  let cursor = full.data.historyNext;
  while (cursor) {
    const page = await request(`http://127.0.0.1:3001/api/workspace/history?cursor=${encodeURIComponent(cursor)}`);
    for (const item of page.data.records) {
      if (seen.has(item.id)) throw new Error(`Duplicate history item ${item.id}`);
      seen.add(item.id);
    }
    pages.push({ ms: page.ms, bytes: page.bytes, records: page.data.records.length });
    cursor = page.data.next;
    if (pages.length > 205) throw new Error('History pagination did not finish');
  }
  const healthAfter = await request('http://127.0.0.1:3001/api/health');
  const result = { runId, fixtureCount: count, recordsSeen: seen.size, pages: pages.length,
    firstPageMs: full.ms, maxPageMs: Math.max(...pages.map(page => page.ms)),
    maxPageBytes: Math.max(...pages.map(page => page.bytes)),
    rssBefore: healthBefore.data.runtime?.rssBytes, rssAfter: healthAfter.data.runtime?.rssBytes, sqlPlan };
  fs.writeFileSync(path.join(directory, 'history.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  if (seen.size < count) process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
