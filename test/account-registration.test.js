const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase, transaction } = require('../src/database/database');
const { testPool } = require('./helpers/pg-pool');
const { createAccountRegistration } = require('../src/services/account-registration');
const { createStarterPack } = require('../src/billing/starter-pack');
const { createAuth } = require('../src/auth/service');
const { createPostgresAuthStore } = require('../src/auth/postgres-store');
const starterConfig = require('../config/starter-pack.json');

test('registration assembles role-aware wallet, starter grant and default chat in the caller transaction', async t => {
  const pool = await openDatabase({}, testPool());
  t.after(() => pool.end());
  const starterPack = createStarterPack({ pool, config: starterConfig });
  const register = createAccountRegistration({ starterPack });
  const user = await transaction(pool, client => register(client, { name: 'Анна' }));
  const admin = await transaction(pool, client => register(client, { name: 'Owner', role: 'admin' }));
  assert.equal((await pool.query('SELECT display_name FROM media_accounts WHERE id=$1', [user])).rows[0].display_name, 'Анна');
  assert.equal((await pool.query('SELECT balance FROM media_wallets WHERE account_id=$1', [user])).rows[0].balance, 150000);
  assert.equal((await pool.query('SELECT balance FROM media_wallets WHERE account_id=$1', [admin])).rows[0].balance, 0);
  assert.equal(Number((await pool.query("SELECT count(*) AS n FROM media_ledger WHERE kind='grant'")).rows[0].n), 1);
  assert.equal(Number((await pool.query("SELECT count(*) AS n FROM media_chats WHERE mode='system'")).rows[0].n), 2);
  await assert.rejects(transaction(pool, client => register(client, { name: 'Invalid', role: 'owner' })), /роль/);
});

test('OAuth repeat login registers once and session failure rolls back assembled account and identity', async t => {
  const pool = await openDatabase({}, testPool());
  t.after(() => pool.end());
  let registrations = 0;
  const register = createAccountRegistration({ starterPack: createStarterPack({ pool, config: starterConfig }) });
  const registerAccount = async (...args) => { registrations++; return register(...args); };
  const auth = createAuth({ pool, store: createPostgresAuthStore({ pool, registerAccount }),
    config: { origin: 'https://app.test', sessionSeconds: 3600, adminIdentities: [] },
    providers: new Map([['google', { label: 'Google', authorize: ({ state }) => `https://identity.test/?state=${state}`,
      exchange: async ({ code }) => ({ subject: code, name: 'Анна' }) }]]),
    registerAccount });
  const login = async (subject, reqHeaders = {}) => {
    const flow = await auth.begin('google');
    return auth.finish({ headers: { ...reqHeaders, cookie: flow.cookie.split(';')[0] } }, 'google',
      new URLSearchParams({ state: new URL(flow.location).searchParams.get('state'), code: subject }));
  };
  const cookies = await login('same');
  const user = await auth.user({ headers: { cookie: cookies[0].split(';')[0] } });
  await login('same');
  assert.equal(registrations, 1);
  assert.equal(user.role, 'user');
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM media_accounts')).rows[0].n), 1);
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM media_chats')).rows[0].n), 1);
  assert.equal(Number((await pool.query("SELECT count(*) AS n FROM media_ledger WHERE kind='grant'")).rows[0].n), 1);

  // A failure after registration and identity insertion must leave neither product nor auth data.
  const originalQuery = pool.connect.bind(pool);
  pool.connect = async () => {
    const client = await originalQuery();
    return { ...client, query: (sql, params) => {
      if (sql.startsWith('INSERT INTO media_sessions')) throw new Error('Session persistence failed');
      return client.query(sql, params);
    } };
  };
  await assert.rejects(login('new'), /Session persistence failed/);
  for (const table of ['media_accounts', 'media_wallets', 'media_chats', 'media_identities', 'media_ledger'])
    assert.equal(Number((await pool.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n), 1, table);
  pool.connect = originalQuery;
  await login('new');
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM media_accounts')).rows[0].n), 2);
});
