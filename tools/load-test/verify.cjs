const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const runId = process.argv[2];
const expected = Number(process.argv[3]);
if (!/^[a-zA-Z0-9_-]{4,80}$/.test(runId || '') || !Number.isInteger(expected) || expected < 1 || expected > 100) {
  throw new Error('Usage: node tools/load-test/verify.cjs <run-id> <expected-jobs: 1..100>');
}
const root = path.resolve(__dirname, '../..');
const line = fs.readFileSync(path.join(root, '.env.load-test'), 'utf8').split(/\r?\n/)
  .find(value => value.startsWith('LOAD_TEST_DATABASE_URL='));
const url = line?.slice('LOAD_TEST_DATABASE_URL='.length) || '';
let target;
try { target = new URL(url); } catch { throw new Error('Invalid test database URL'); }
if (target.hostname !== 'node1.pghost.ru' || target.pathname !== '/bothost_db_c5e6aab87bbb') {
  throw new Error('Unexpected test database');
}

async function snapshot(client, sessions) {
  const prefix = `load:${runId}:%`;
  const percentiles = values => {
    if (!values.length) return { count: 0 };
    values.sort((a, b) => a - b);
    return { count: values.length, p50Ms: values[Math.ceil(values.length * 0.5) - 1],
      p95Ms: values[Math.ceil(values.length * 0.95) - 1], maxMs: values.at(-1) };
  };
  const jobs = await client.query(`SELECT data->>'state' AS state,count(*)::int AS count
    FROM media_records WHERE namespace='history' AND data->>'requestId' LIKE $1
    GROUP BY state ORDER BY state`, [prefix]);
  const reservations = await client.query(`SELECT r.state,count(*)::int AS count,sum(r.amount)::bigint AS units
    FROM media_reservations r JOIN media_records m ON m.id=r.job_id AND m.account_id=r.account_id
    WHERE m.namespace='history' AND m.data->>'requestId' LIKE $1 GROUP BY r.state ORDER BY r.state`, [prefix]);
  const ledger = await client.query(`SELECT l.kind,count(*)::int AS count,sum(l.amount)::bigint AS units
    FROM media_ledger l JOIN media_records m ON m.id=l.reference AND m.account_id=l.account_id
    WHERE m.namespace='history' AND m.data->>'requestId' LIKE $1 GROUP BY l.kind ORDER BY l.kind`, [prefix]);
  const submissions = await client.query(`SELECT s.outcome,count(*)::int AS count
    FROM media_kie_submissions s JOIN media_records m ON m.id=s.job_id AND m.account_id=s.account_id
    WHERE m.namespace='history' AND m.data->>'requestId' LIKE $1 GROUP BY s.outcome ORDER BY s.outcome`, [prefix]);
  const held = await client.query(`SELECT coalesce(sum(w.held),0)::bigint AS held
    FROM media_wallets w WHERE w.account_id IN (SELECT DISTINCT account_id FROM media_records
      WHERE namespace='history' AND data->>'requestId' LIKE $1)`, [prefix]);
  const timestamps = await client.query(`SELECT data->>'queuedAt' AS queued,
    data->>'providerAcceptedAt' AS accepted,data->>'generationCompletedAt' AS completed
    FROM media_records WHERE namespace='history' AND data->>'requestId' LIKE $1`, [prefix]);
  const elapsed = (from, to) => timestamps.rows.map(row => Date.parse(row[to]) - Date.parse(row[from]))
    .filter(value => Number.isFinite(value) && value >= 0);
  const starts = (await client.query(`SELECT s.started_at FROM media_kie_submissions s
    JOIN media_records m ON m.id=s.job_id AND m.account_id=s.account_id
    WHERE m.namespace='history' AND m.data->>'requestId' LIKE $1 ORDER BY s.started_at`, [prefix]))
    .rows.map(row => new Date(row.started_at).getTime());
  let journalPeak10s = 0;
  for (let left = 0, right = 0; right < starts.length; right++) {
    while (starts[right] - starts[left] >= 10000) left++;
    journalPeak10s = Math.max(journalPeak10s, right - left + 1);
  }
  const individual = await client.query(`SELECT m.account_id,m.data->>'requestId' AS request_id,m.data->>'state' AS state,
    (SELECT count(*)::int FROM media_reservations r WHERE r.account_id=m.account_id AND r.job_id=m.id AND r.state='captured') AS captured,
    (SELECT count(*)::int FROM media_ledger l WHERE l.account_id=m.account_id AND l.reference=m.id AND l.kind='reserve') AS reserves,
    (SELECT count(*)::int FROM media_ledger l WHERE l.account_id=m.account_id AND l.reference=m.id AND l.kind='capture') AS captures,
    (SELECT count(*)::int FROM media_kie_submissions s WHERE s.account_id=m.account_id AND s.job_id=m.id AND s.outcome='accepted') AS accepted
    FROM media_records m WHERE m.namespace='history' AND m.data->>'requestId' LIKE $1`, [prefix]);
  const byId = new Map(individual.rows.map(row => [row.request_id, row]));
  const mismatches = [];
  for (let index = 0; index < expected; index++) {
    const requestId = `load:${runId}:${index}`;
    const row = byId.get(requestId);
    if (!row || row.account_id !== sessions[index % sessions.length].id || row.state !== 'success'
      || row.captured !== 1 || row.reserves !== 1 || row.captures !== 1 || row.accepted !== 1) mismatches.push(requestId);
  }
  return { runId, expected, jobs: jobs.rows, reservations: reservations.rows, ledger: ledger.rows,
    submissions: submissions.rows, walletHeldUnits: held.rows[0].held,
    individualMismatches: mismatches, queueToProvider: percentiles(elapsed('queued', 'accepted')),
    queueToCompletion: percentiles(elapsed('queued', 'completed')), journalPeak10s };
}

async function main() {
  const sessions = JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'load-tests', runId, 'sessions.json'), 'utf8'));
  if (!sessions.length) throw new Error('No test sessions');
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 10000 });
  await client.connect();
  try {
    let result;
    for (let attempt = 0; attempt < 60; attempt++) {
      result = await snapshot(client, sessions);
      const terminal = result.jobs.filter(row => ['success', 'fail', 'blocked', 'unknown', 'cancelled'].includes(row.state))
        .reduce((sum, row) => sum + row.count, 0);
      if (terminal === expected) break;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    const directory = path.join(root, 'artifacts', 'load-tests', runId);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'queue-verification.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
    const count = result.jobs.reduce((sum, row) => sum + row.count, 0);
    const matches = (rows, kind) => rows.find(row => (row.kind || row.state || row.outcome) === kind)?.count === expected;
    if (count !== expected || result.individualMismatches.length || result.jobs.some(row => row.state !== 'success') || result.walletHeldUnits !== '0'
      || !matches(result.reservations, 'captured') || !matches(result.ledger, 'reserve')
      || !matches(result.ledger, 'capture') || !matches(result.submissions, 'accepted')) process.exitCode = 1;
  } finally { await client.end(); }
}
main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
