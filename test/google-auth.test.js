const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createGoogleAuth } = require('../src/auth/google-auth');
const { createOAuthAuth, hash } = require('../src/auth/oauth');

// A different application's storage: no media tables, PostgreSQL, wallet or chats.
function fixture() {
  const flows = new Map(), sessions = new Map(), users = new Map();
  const store = {
    async createFlow(flow) { flows.set(flow.stateHash, flow); },
    async consumeFlow(key) {
      const flow = flows.get(key.stateHash);
      if (!flow || flow.browserHash !== key.browserHash || flow.provider !== key.provider || flow.expiresAt <= new Date()) return null;
      flows.delete(key.stateHash); return { verifier: flow.verifier };
    },
    async completeLogin({ provider, profile, session }) {
      const id = `${provider}:${profile.subject}`;
      if (!users.has(id)) users.set(id, { id, name: profile.name, role: 'member' });
      await store.replaceSession(null, { ...session, accountId: id });
    },
    async replaceSession(_context, session) {
      if (session.previousTokenHash) sessions.delete(session.previousTokenHash);
      sessions.set(session.tokenHash, session);
    },
    async getSession(tokenHash) {
      const session = sessions.get(tokenHash);
      return session && session.expiresAt > new Date() ? users.get(session.accountId) : null;
    },
    async deleteSession(tokenHash) { sessions.delete(tokenHash); },
    async identities(id) { return [{ provider: 'google', subject: id.split(':')[1] }]; },
  };
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => url.endsWith('/token') ? { access_token: 'server-only-token' }
      : { sub: '123', name: 'Анна', email: 'ANNA@example.test', email_verified: true } };
  };
  const auth = createGoogleAuth({ store, origin: 'https://other.test', cookiePrefix: 'other',
    callbackPath: () => '/login/google/return', clientId: 'other-client', clientSecret: 'private-secret', fetcher });
  const start = async () => {
    const flow = await auth.begin('google');
    const state = new URL(flow.location).searchParams.get('state');
    return { flow, state, req: { headers: { cookie: flow.cookie.split(';')[0] } },
      params: new URLSearchParams({ state, code: 'provider-code' }) };
  };
  return { auth, store, flows, sessions, users, calls, start };
}

test('Google login runs with another application store, custom routes and current application roles', async () => {
  const f = fixture(), first = await f.start();
  const url = new URL(first.flow.location);
  assert.equal(url.searchParams.get('redirect_uri'), 'https://other.test/login/google/return');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(!url.href.includes('private-secret'));
  const flow = f.flows.get(hash(first.state));
  assert.equal(url.searchParams.get('code_challenge'), require('node:crypto').createHash('sha256').update(flow.verifier).digest('base64url'));
  const cookies = await f.auth.finish(first.req, 'google', first.params);
  assert.match(cookies[0], /^__Host-other-session=.*HttpOnly; SameSite=Lax;.*Secure$/);
  const req = { headers: { cookie: cookies[0].split(';')[0] } };
  assert.deepEqual(await f.auth.user(req), { id: 'google:123', name: 'Анна', role: 'member' });
  assert.equal(f.calls[0].options.body.get('code_verifier'), flow.verifier);
  assert.equal(f.calls[0].options.body.get('client_secret'), 'private-secret');
  assert.equal(f.calls[1].options.headers.Authorization, 'Bearer server-only-token');
  assert.ok(!JSON.stringify([...f.sessions.values()]).includes(cookies[0].split(';')[0].split('=')[1]));
  assert.ok(!JSON.stringify([...f.sessions.values()]).includes('server-only-token'));
  f.users.get('google:123').role = 'editor';
  assert.equal((await f.auth.user(req)).role, 'editor');
  const second = await f.start();
  second.req.headers.cookie += '; ' + req.headers.cookie;
  const rotated = await f.auth.finish(second.req, 'google', second.params);
  assert.equal(f.users.size, 1);
  assert.equal(await f.auth.user(req), null);
  const newReq = { headers: { cookie: rotated[0].split(';')[0] } };
  await f.auth.logout(newReq);
  assert.equal(await f.auth.user(newReq), null);
});

test('OAuth flow rejects foreign browser, wrong provider, expiry and callback replay', async () => {
  const f = fixture(), one = await f.start();
  await assert.rejects(f.auth.finish({ headers: {} }, 'google', one.params), /устарел/);
  const two = await f.start();
  await assert.rejects(f.auth.finish(two.req, 'google', one.params), /не подтверждён/);
  await assert.rejects(f.auth.finish(one.req, 'vk', one.params), /устарел/);
  assert.equal(f.calls.length, 0);
  await f.auth.finish(one.req, 'google', one.params);
  await assert.rejects(f.auth.finish(one.req, 'google', one.params), /не подтверждён/);
  f.flows.get(hash(two.state)).expiresAt = new Date(0);
  await assert.rejects(f.auth.finish(two.req, 'google', two.params), /не подтверждён/);
  assert.equal(f.calls.length, 2);
});

test('Google entrypoint works when only its three files are copied to another module directory', async t => {
  const root = path.join(__dirname, '../artifacts');
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'google-portability-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const file of ['google-auth.js', 'google.js', 'oauth.js'])
    await fs.copyFile(path.join(__dirname, '../src/auth', file), path.join(directory, file));
  const copied = require(path.join(directory, 'google-auth.js'));
  const f = fixture();
  const auth = copied.createGoogleAuth({ store: f.store, origin: 'http://localhost:4567', clientId: 'id', clientSecret: 'secret' });
  const flow = await auth.begin('google');
  assert.equal(new URL(flow.location).searchParams.get('redirect_uri'), 'http://localhost:4567/auth/google/callback');
  assert.match(flow.cookie, /^auth-flow=/);
});

test('OAuth rejects missing store operations and unsafe deployment configuration', () => {
  const f = fixture();
  assert.throws(() => createOAuthAuth({ store: {}, providers: new Map(), origin: 'https://other.test' }), /store operation/);
  for (const origin of ['http://public.test', 'https://other.test/path', 'ftp://other.test'])
    assert.throws(() => createOAuthAuth({ store: f.store, providers: new Map(), origin }), /origin/);
});
