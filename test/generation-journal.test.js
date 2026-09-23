const { test } = require('node:test');
const assert = require('node:assert/strict');
const { appendGenerationEvent, generationJournal } = require('../src/services/generation-journal');

test('generation journal keeps provider attempts per account without prompts or secrets', async () => {
  const rows = [];
  const pool = {
    async query(sql, args) {
      if (sql.startsWith('INSERT')) {
        rows.push({ account: args[0], namespace: args[1], id: args[2], data: JSON.parse(args[3]) });
        return { rows: [] };
      }
      const scoped = rows.filter(row => row.account === args[0] && row.namespace === args[1]
        && (args[2] === 'all' || row.data.provider === args[2]));
      if (sql.includes('COUNT(*)')) return { rows: [{
        generations: scoped.filter(row => row.data.event === 'created').length,
        send_attempts: scoped.filter(row => ['submitting', 'send_start'].includes(row.data.event)).length,
      }] };
      return { rows: scoped.slice(args[3], args[3] + 51) };
    },
  };
  const record = { id: 'job-1', requestId: 'request-1', model: 'flux.3-video', kind: 'video',
    prompt: 'private prompt', apiKey: 'private key', nativeQuote: { credits: 93, version: 'rate-v1' } };
  await appendGenerationEvent(pool, 'account-a', 'routerai', record, 'created');
  await appendGenerationEvent(pool, 'account-a', 'routerai', record, 'send_start');
  await appendGenerationEvent(pool, 'account-b', 'codex', { ...record, id: 'job-2' }, 'send_start');
  const own = await generationJournal(pool, 'account-a', { provider: 'routerai' });
  assert.deepEqual(own.summary, { generations: 1, sendAttempts: 1 });
  assert.equal(own.items.length, 2);
  assert.ok(own.items.every(item => item.provider === 'routerai' && !JSON.stringify(item).includes('private')));
  const other = await generationJournal(pool, 'account-b');
  assert.equal(other.items.length, 1);
  assert.equal(other.items[0].provider, 'codex');
});
