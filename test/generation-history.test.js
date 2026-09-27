const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { openDatabase } = require('../src/database/database');
const { testPool } = require('./helpers/pg-pool');
const { generationHistory, generationHistorySince } = require('../src/services/generation-history');

test('active Codex and RouterAI cards recover transitions older than the delta cursor', async t => {
  const pool = await openDatabase({}, testPool());
  t.after(() => pool.end());
  const owner = randomUUID(), other = randomUUID(), jobId = randomUUID(), kieId = randomUUID();
  for (const account of [owner, other]) {
    await pool.query("INSERT INTO media_accounts(id,display_name) VALUES($1,'Delta test')", [account]);
    for (const provider of ['codex', 'routerai']) {
      await pool.query("INSERT INTO media_records(account_id,namespace,id,data,updated_at) VALUES($1,$2,$3,$4,'2026-09-27T09:00:00Z')",
        [account, provider, `${provider}:${account}:${jobId}`, JSON.stringify({ id: jobId, model: 'gpt-5.5', state: 'running', revision: 2, createdAt: '2026-09-27T09:00:00Z', prompt: account })]);
    }
  }
  const since = '2026-09-27T09:00:01Z', before = '2026-09-27T09:00:02Z';
  const service = { listHistorySince: async (_since, _before, ids) => { assert.deepEqual(ids, [kieId]); return []; } };
  const active = [kieId, `codex:${jobId}`, `routerai:${jobId}`];
  const rows = await generationHistorySince(pool, owner, service, since, before, undefined, active);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.state === 'generating' && row.revision === 2 && row.input.prompt === owner));
  await pool.query("UPDATE media_records SET data=jsonb_set(data,'{state}','\"success\"') WHERE account_id=$1", [owner]);
  const completed = await generationHistorySince(pool, owner, service, since, before, undefined, active);
  assert.ok(completed.every(row => row.state === 'success'));
  assert.deepEqual(await generationHistorySince(pool, owner, service, since, before, undefined, [kieId]), []);
});

test('history includes persisted Codex results and states, isolates accounts and preserves Kie presentation', async t => {
  const pool = await openDatabase({}, testPool());
  t.after(() => pool.end());
  const owner = randomUUID(), other = randomUUID();
  for (const id of [owner, other]) await pool.query("INSERT INTO media_accounts(id,display_name) VALUES($1,'Test')", [id]);
  const jobs = [
    { state: 'success', kind: 'image', hasImage: true },
    { state: 'success', kind: 'text', output: '<script>plain text</script>' },
    { state: 'running' }, { state: 'fail', error: 'Failed' }, { state: 'unknown' }
  ].map((value, index) => ({ id: randomUUID(), model: 'gpt-5.5', effort: 'medium', speed: 'fast', prompt: 'Saved prompt',
    createdAt: `2026-09-18T12:00:0${index}Z`, nativeQuote: { credits: 4 }, usage: { total_tokens: 120 }, secret: 'excluded', ...value }));
  for (const job of jobs) await pool.query("INSERT INTO media_records(account_id,namespace,id,data) VALUES($1,'codex',$2,$3)", [owner, `codex:${owner}:${job.id}`, JSON.stringify(job)]);
  const foreign = { ...jobs[0], id: randomUUID(), prompt: 'Private other account' };
  await pool.query("INSERT INTO media_records(account_id,namespace,id,data) VALUES($1,'codex',$2,$3)", [other, `codex:${other}:${foreign.id}`, JSON.stringify(foreign)]);
  const service = { listHistory: async () => [{ id: 'kie-job', providerId: 'kie', createdAt: '2026-09-17', kind: 'video' }] };
  const rows = await generationHistory(pool, owner, service, row => ({ ...row, presented: true }));
  assert.equal(rows.length, 6);
  assert.equal(rows[0].state, 'unknown');
  assert.equal(rows.at(-1).presented, true);
  assert.equal(rows.filter(row => row.state === 'generating').length, 1);
  assert.ok(rows.every(row => row.secret === undefined));
  assert.ok(rows.every(row => row.input?.prompt !== foreign.prompt));
  const image = rows.find(row => row.kind === 'image');
  assert.equal(image.localFiles[0].previewUrl, `/api/codex/jobs/${jobs[0].id}/image`);
  assert.equal(image.nativeQuote.credits, 4);
  assert.equal(image.usage.total_tokens, 120);
  assert.equal(rows.find(row => row.output).output, jobs[1].output);
  const reloaded = await generationHistory(pool, owner, { listHistory: async () => [] });
  assert.equal(reloaded.length, 5);
  assert.equal((await generationHistory(pool, other, { listHistory: async () => [] })).length, 1);
});
