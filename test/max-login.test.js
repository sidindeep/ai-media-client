const { createAccountRegistration } = require('../src/services/account-registration');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { openDatabase } = require('../src/database/database');
const { testPool } = require('./helpers/pg-pool');
const { createMaxAuth, verifyMaxInitData } = require('../src/auth/max-login');

function signedData(values, botToken) {
  const params = new URLSearchParams(values);
  const signed = [...params.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', createHmac('sha256', secret).update(signed).digest('hex'));
  return params.toString();
}

test('MAX signed launch approves only its one-time browser flow', async t => {
  const pool = await openDatabase({}, testPool());
  t.after(() => pool.end());
  const config = { origin: 'https://app.test', max: { botName: 'StudioBot', botToken: 'private-token' }, adminIdentities: [] };
  const max = createMaxAuth({ pool, config, registerAccount: createAccountRegistration(), issueSession: async (_client, _req, accountId) => `session-${accountId}`,
    cookieValue: (req, name) => req.headers.cookie.split(';').map(item => item.trim()).find(item => item.startsWith(`${name}=`))?.slice(name.length + 1) || '' });
  const start = await max.begin();
  const request = { headers: { cookie: start.cookie.split(';')[0] } };
  const link = await max.link(request);
  assert.equal(new URL(link).hostname, 'max.ru');
  assert.deepEqual(await max.status(request), { ready: false });
  const state = new URL(link).searchParams.get('startapp');
  const data = signedData({ auth_date: String(Math.floor(Date.now() / 1000)), start_param: state,
    user: JSON.stringify({ id: 123, first_name: 'Анна' }) }, config.max.botToken);
  assert.deepEqual(verifyMaxInitData(data, config.max.botToken), { state, subject: '123', name: 'Анна' });
  await assert.rejects(max.confirm(data.replace('123', '124')), /Подпись MAX/);
  await max.confirm(data);
  const result = await max.status(request);
  assert.equal(result.ready, true);
  assert.match(result.cookie[0], /^session-/);
  assert.equal((await pool.query("SELECT count(*) AS n FROM media_identities WHERE provider='max'")).rows[0].n, 1);
  assert.equal((await pool.query('SELECT count(*) AS n FROM media_wallets')).rows[0].n, 1);
  assert.equal((await pool.query('SELECT count(*) AS n FROM media_chats')).rows[0].n, 1);
  await assert.rejects(max.status(request), /устарел/);
  await assert.rejects(max.confirm(data), /устарел/);
});
