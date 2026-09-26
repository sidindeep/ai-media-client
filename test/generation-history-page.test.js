const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { openDatabase } = require('../src/database/database');
const { testPool } = require('./helpers/pg-pool');
const { generationHistoryPage, generationActive } = require('../src/services/generation-history');

test('history pages keep older records reachable while active jobs stay in the initial snapshot', async t => {
  const pool = await openDatabase({}, testPool());
  t.after(() => pool.end());
  const account = randomUUID(), other = randomUUID();
  await pool.query("INSERT INTO media_accounts(id,display_name) VALUES($1,'Page'),($2,'Other')", [account, other]);
  const rows = Array.from({ length: 117 }, (_, index) => {
    const namespace = ['history', 'codex', 'routerai'][index % 3];
    const id = randomUUID();
    return { namespace, id, data: { id, state: 'success', createdAt: new Date(Date.UTC(2026, 8, 26, 0, index)).toISOString(), model: 'test', modelId: 'test', input: {} } };
  });
  rows.push({ namespace: 'history', id: randomUUID(), data: { id: randomUUID(), state: 'generating', createdAt: '2026-01-01T00:00:00.000Z' } });
  rows[rows.length - 1].data.id = rows[rows.length - 1].id;
  await pool.query(`INSERT INTO media_records(account_id,namespace,id,data)
    SELECT $1,namespace,id,data FROM jsonb_to_recordset($2::jsonb) AS item(namespace text,id text,data jsonb)`, [account, JSON.stringify(rows)]);
  await pool.query("INSERT INTO media_records(account_id,namespace,id,data) VALUES($1,'history','private',$2)",
    [other, JSON.stringify({ id: 'private', state: 'success', createdAt: '2026-12-01T00:00:00.000Z' })]);
  const service = { presentHistory: async items => items };
  const first = await generationHistoryPage(pool, account, service, null);
  const second = await generationHistoryPage(pool, account, service, first.next);
  const third = await generationHistoryPage(pool, account, service, second.next);
  const ids = [...first.records, ...second.records, ...third.records].map(item => item.id.replace(/^(codex|routerai):/, ''));
  assert.equal(first.records.length, 50);
  assert.equal(second.records.length, 50);
  assert.equal(third.records.length, 17);
  assert.equal(third.next, null);
  assert.equal(new Set(ids).size, 117);
  assert.ok(!ids.includes('private'));
  assert.deepEqual((await generationActive(pool, account, service)).map(item => item.id), [rows.at(-1).id]);
  await assert.rejects(generationHistoryPage(pool, account, service, 'bad!'), /курсор/);
});
