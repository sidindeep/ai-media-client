const { Pool } = require('pg');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');

async function main() {
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    const account = randomUUID(), target = randomUUID(), other = randomUUID();
    await client.query('CREATE TEMP TABLE bench_records (account_id uuid NOT NULL,namespace text NOT NULL,id text NOT NULL,data jsonb NOT NULL)');
    await client.query(`INSERT INTO bench_records(account_id,namespace,id,data)
      SELECT $1,'history',g::text,jsonb_build_object('chatId',CASE WHEN g%100=0 THEN $2::text ELSE $3::text END,
      'projectId',CASE WHEN g%80=0 THEN $2::text ELSE $3::text END)
      FROM generate_series(1,100000) g`, [account, target, other]);
    await client.query('ANALYZE bench_records');
    const insertSample = async from => {
      const started = performance.now();
      await client.query(`INSERT INTO bench_records(account_id,namespace,id,data)
        SELECT $1,'history',g::text,jsonb_build_object('chatId',$2::text,'projectId',$3::text)
        FROM generate_series($4::int,$5::int) g`, [account, target, other, from, from + 9999]);
      return Math.round(performance.now() - started);
    };
    const insertBeforeIndexMs = await insertSample(100001);
    const measure = async (column, before) => {
      const result = await client.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
        SELECT count(*) FROM bench_records WHERE account_id=$1 AND data->>$2=$3`, [account, column, target]);
      const plan = result.rows[0]['QUERY PLAN'][0];
      return { case: column, index: !before, executionMs: plan['Execution Time'], sharedHitBlocks: plan.Plan['Shared Hit Blocks'],
        topNode: plan.Plan['Plans']?.[0]?.['Node Type'] || plan.Plan['Node Type'] };
    };
    const before = [await measure('chatId', true), await measure('projectId', true)];
    await client.query("CREATE INDEX bench_records_chat ON bench_records(account_id,(data->>'chatId'))");
    await client.query("CREATE INDEX bench_records_project ON bench_records(account_id,(data->>'projectId'))");
    await client.query('ANALYZE bench_records');
    const insertAfterIndexMs = await insertSample(110001);
    const after = [await measure('chatId', false), await measure('projectId', false)];
    const sizes = (await client.query(`SELECT pg_relation_size('bench_records') AS table_bytes,
      pg_relation_size('bench_records_chat') AS chat_index_bytes,
      pg_relation_size('bench_records_project') AS project_index_bytes`)).rows[0];
    process.stdout.write(JSON.stringify({ rows: 120000, before, after, insert10000Ms: { beforeIndex: insertBeforeIndexMs, afterIndex: insertAfterIndexMs }, sizes }, null, 2) + '\n');
  } finally { client.release(); await pool.end(); }
}
main().catch(error => { process.stderr.write(`${error.code || error.message}\n`); process.exitCode = 1; });
