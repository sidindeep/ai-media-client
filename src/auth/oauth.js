const { randomBytes, createHash } = require('node:crypto');
const token = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const cookieValue = (req, name) => (req.headers.cookie || '').split(';').map(item => item.trim()).find(item => item.startsWith(name + '='))?.slice(name.length + 1) || '';

function createOAuthAuth({ store, providers, origin, sessionSeconds = 604800, cookiePrefix = 'auth', callbackPath = id => `/auth/${id}/callback` }) {
  for (const method of ['replaceSession', 'getSession', 'deleteSession', 'createFlow', 'consumeFlow', 'completeLogin', 'identities'])
    if (typeof store?.[method] !== 'function') throw new Error(`Auth store operation is required: ${method}`);
  const address = new URL(origin);
  if (address.origin !== origin || (address.protocol !== 'https:' && !(address.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname)))) throw new Error('Auth origin must be HTTPS or local HTTP');
  if (!Number.isSafeInteger(sessionSeconds) || sessionSeconds < 1) throw new Error('Invalid session lifetime');
  if (!/^[a-zA-Z0-9_-]+$/.test(cookiePrefix)) throw new Error('Invalid auth cookie prefix');
  const secure = address.protocol === 'https:';
  const name = suffix => `${secure ? '__Host-' : ''}${cookiePrefix}-${suffix}`;
  const sessionName = name('session'), flowName = name('flow');
  const cookie = (key, value, age) => `${key}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? '; Secure' : ''}`;
  const redirectUri = id => {
    const url = new URL(callbackPath(id), origin);
    if (url.origin !== origin) throw new Error('OAuth callback must use the auth origin');
    return url.href;
  };
  const session = req => {
    const raw = token(), previous = cookieValue(req, sessionName);
    return { cookie: cookie(sessionName, raw, sessionSeconds),
      record: { tokenHash: hash(raw), previousTokenHash: previous ? hash(previous) : null,
        expiresAt: new Date(Date.now() + sessionSeconds * 1000) } };
  };
  return {
    sessionName,
    identities: accountId => store.identities(accountId),
    providers: () => [...providers].map(([id, adapter]) => ({ id, label: adapter.label })),
    async issueSession(context, req, accountId) {
      const next = session(req);
      await store.replaceSession(context, { ...next.record, accountId });
      return next.cookie;
    },
    async user(req) {
      const raw = cookieValue(req, sessionName);
      return /^[\w-]{43}$/.test(raw) ? store.getSession(hash(raw)) : null;
    },
    async begin(provider) {
      const adapter = providers.get(provider);
      if (!adapter) throw new Error('Этот способ входа ещё не настроен');
      const state = token(), browser = token(), verifier = token();
      const location = adapter.authorize({ state, challenge: hashChallenge(verifier), redirectUri: redirectUri(provider) });
      await store.createFlow({ stateHash: hash(state), browserHash: hash(browser), provider, verifier,
        expiresAt: new Date(Date.now() + 600000) });
      return { cookie: cookie(flowName, browser, 600), location };
    },
    async finish(req, provider, params) {
      const adapter = providers.get(provider), state = params.get('state'), browser = cookieValue(req, flowName);
      if (!adapter || !/^[\w-]{43}$/.test(state || '') || !/^[\w-]{43}$/.test(browser)) throw new Error('Вход устарел. Начните заново');
      const flow = await store.consumeFlow({ stateHash: hash(state), browserHash: hash(browser), provider });
      if (!flow || params.get('error') || !params.get('code') || params.get('code').length > 4096) throw new Error('Вход не подтверждён. Начните заново');
      let profile;
      try { profile = await adapter.exchange({ state, code: params.get('code'), deviceId: params.get('device_id'),
        verifier: flow.verifier, redirectUri: redirectUri(provider) }); }
      catch { throw new Error('Не удалось подтвердить аккаунт у провайдера'); }
      if (typeof profile?.subject !== 'string' || !profile.subject || profile.subject.length > 255) throw new Error('Некорректный аккаунт');
      const next = session(req);
      await store.completeLogin({ provider, profile, session: next.record });
      return [next.cookie, cookie(flowName, '', 0)];
    },
    async logout(req) {
      const raw = cookieValue(req, sessionName);
      if (raw) await store.deleteSession(hash(raw));
      return cookie(sessionName, '', 0);
    },
  };
}
const hashChallenge = verifier => createHash('sha256').update(verifier).digest('base64url');
module.exports = { createOAuthAuth, hash, cookieValue };
