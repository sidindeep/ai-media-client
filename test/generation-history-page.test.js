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

test('chat history pages find unassigned records older than the account first page', async t => {
  const pool = await openDatabase({}, testPool());
  t.after(() => pool.end());
  const account = randomUUID(), other = randomUUID(), chatId = randomUUID();
  await pool.query("INSERT INTO media_accounts(id,display_name) VALUES($1,'Chat'),($2,'Other')", [account, other]);
  const rows = Array.from({ length: 151 }, (_, index) => {
    const id = randomUUID();
    return { namespace: 'history', id, data: { id, state: 'success', chatId: index < 71 ? null : chatId,
      createdAt: new Date(Date.UTC(2026, 8, 26, 0, index)).toISOString(), modelId: 'test', input: {} } };
  });
  await pool.query(`INSERT INTO media_records(account_id,namespace,id,data)
    SELECT $1,namespace,id,data FROM jsonb_to_recordset($2::jsonb) AS item(namespace text,id text,data jsonb)`, [account, JSON.stringify(rows)]);
  await pool.query("INSERT INTO media_records(account_id,namespace,id,data) VALUES($1,'history','private',$2)",
    [other, JSON.stringify({ id: 'private', state: 'success', chatId: null, createdAt: '2026-12-01T00:00:00.000Z' })]);
  const service = { presentHistory: async items => items };
  const accountPage = await generationHistoryPage(pool, account, service, null);
  assert.equal(accountPage.records.some(item => !item.chatId), false);
  const first = await generationHistoryPage(pool, account, service, null, undefined, 50, 'system:recent');
  const second = await generationHistoryPage(pool, account, service, first.next, undefined, 50, 'system:recent');
  assert.equal(first.records.length, 50);
  assert.equal(second.records.length, 21);
  assert.equal(second.next, null);
  assert.equal(new Set([...first.records, ...second.records].map(item => item.id)).size, 71);
  assert.ok(!first.records.some(item => item.id === 'private'));
  const assigned = await generationHistoryPage(pool, account, service, null, undefined, 50, chatId);
  assert.equal(assigned.records.length, 50);
  assert.ok(assigned.records.every(item => item.chatId === chatId));
  await assert.rejects(generationHistoryPage(pool, account, service, null, undefined, 50, 'invalid'), /чат/);
});
