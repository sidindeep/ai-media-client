const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, sign } = require('node:crypto');
const { createProviders } = require('../src/auth/providers');
test('Google code exchange keeps secrets server-side and obtains subject from userinfo', async () => {
  const calls = [];
  const adapters = createProviders({ google: { clientId: 'client', clientSecret: 'secret' }, vk: {} }, async (url, options) => {
    calls.push({ url, options }); return { ok: true, json: async () => calls.length === 1 ? { access_token: 'access' } : { sub: 'immutable-id', name: 'Имя' } };
  });
  const adapter = adapters.get('google');
  const params = { state: 'state', challenge: 'challenge', redirectUri: 'https://app.test/auth/google/callback', code: 'code', verifier: 'verifier' };
  const url = new URL(adapter.authorize(params));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256'); assert.ok(!url.href.includes('secret'));
  assert.deepEqual(await adapter.exchange(params), { subject: 'immutable-id', name: 'Имя' });
  assert.equal(calls[0].options.body.get('client_secret'), 'secret');
  assert.equal(calls[0].options.body.get('code_verifier'), 'verifier');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer access');
});
test('VK binds device, verifier and returned state, and rejects mismatched token response', async () => {
  let badState = false;
  const adapters = createProviders({ google: {}, vk: { clientId: 'vk-client' } }, async (url, options) => {
    assert.equal(new URL(url).host, 'id.vk.ru');
    if (url.endsWith('/auth')) {
      assert.equal(options.body.get('device_id'), 'device'); assert.equal(options.body.get('code_verifier'), 'verifier');
      return { ok: true, json: async () => ({ access_token: 'access', state: badState ? 'other' : 'state' }) };
    }
    return { ok: true, json: async () => ({ user: { user_id: 123, first_name: 'Имя' } }) };
  });
  const params = { code: 'code', verifier: 'verifier', redirectUri: 'https://app.test/auth/vk/callback', state: 'state', deviceId: 'device' };
  assert.equal((await adapters.get('vk').exchange(params)).subject, '123');
  badState = true; await assert.rejects(adapters.get('vk').exchange(params));
  await assert.rejects(adapters.get('vk').exchange({ ...params, deviceId: '' }));
});
test('Google supplies bootstrap email only when explicitly verified by userinfo', async () => {
  for (const verified of [false, 'true', undefined, true]) {
    const adapters = createProviders({ google: { clientId: 'client', clientSecret: 'secret' }, vk: {} }, async url => ({ ok: true, json: async () => url.includes('/token') ? { access_token: 'access' } : { sub: 'subject', email: 'Owner@Example.test', email_verified: verified } }));
    const profile = await adapters.get('google').exchange({ code: 'code', verifier: 'verifier', redirectUri: 'https://app.test/auth/google/callback' });
    assert.equal(profile.verifiedEmail, verified === true ? 'owner@example.test' : undefined);
  }
});
test('Yandex exchanges PKCE code and accepts only a profile issued for this app', async () => {
  const calls = [];
  const adapters = createProviders({ google: {}, vk: {}, yandex: { clientId: 'ya-app', clientSecret: 'secret' } }, async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => url.endsWith('/token') ? { access_token: 'ya-access' }
      : { id: '123', client_id: calls.clientId || 'ya-app', first_name: 'Анна' } };
  });
  const adapter = adapters.get('yandex');
  const params = { state: 'state', challenge: 'challenge', redirectUri: 'https://app.test/auth/yandex/callback', code: 'code', verifier: 'verifier' };
  const url = new URL(adapter.authorize(params));
  assert.equal(url.origin, 'https://oauth.yandex.ru');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(!url.href.includes('secret'));
  assert.deepEqual(await adapter.exchange(params), { subject: '123', name: 'Анна' });
  assert.equal(calls[0].options.body.get('code_verifier'), 'verifier');
  assert.equal(calls[1].options.headers.Authorization, 'OAuth ya-access');
  calls.clientId = 'another-app';
  await assert.rejects(adapter.exchange(params), /Некорректный аккаунт/);
});
test('Telegram checks the signed ID token and audience before creating a profile', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
  let audience = 'bot-id';
  const fetcher = async url => ({ ok: true, json: async () => url.endsWith('/token')
    ? { id_token: (() => {
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ iss: 'https://oauth.telegram.org', aud: audience, sub: 'tg-123', name: 'Анна',
        iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url');
      return `${header}.${payload}.${sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')}`;
    })() } : { keys: [jwk] } });
  const adapter = createProviders({ google: {}, vk: {}, telegram: { clientId: 'bot-id', clientSecret: 'secret' } }, fetcher).get('telegram');
  const params = { state: 'state', challenge: 'challenge', redirectUri: 'https://app.test/auth/telegram/callback', code: 'code', verifier: 'verifier' };
  assert.equal(new URL(adapter.authorize(params)).searchParams.get('scope'), 'openid profile');
  assert.deepEqual(await adapter.exchange(params), { subject: 'tg-123', name: 'Анна' });
  audience = 'another-bot';
  await assert.rejects(adapter.exchange(params), /Некорректные данные Telegram/);
});
