const test = require('node:test');
const assert = require('node:assert/strict');
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
