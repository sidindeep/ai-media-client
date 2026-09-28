// Each identity provider implements authorize() and exchange(). Never accept browser profile data.
const { verifyTelegramIdToken } = require('./telegram-oidc');
async function responseJson(fetcher, url, options) {
  const response = await fetcher(url, { ...options, signal: AbortSignal.timeout(15000), redirect: 'error' });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error('Провайдер не подтвердил вход');
  return data;
}
function createProviders(config, fetcher = fetch) {
  const registry = new Map();
  const authorize = (endpoint, params) => { const url = new URL(endpoint); url.search = new URLSearchParams(params).toString(); return url.href; };
  if (config.google.clientId && config.google.clientSecret) registry.set('google', {
    label: 'Google',
    authorize: ({ state, challenge, redirectUri }) => authorize('https://accounts.google.com/o/oauth2/v2/auth', {
      client_id: config.google.clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid profile email',
      state, code_challenge: challenge, code_challenge_method: 'S256'
    }),
    async exchange({ code, verifier, redirectUri }) {
      const token = await responseJson(fetcher, 'https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({
        grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri,
        client_id: config.google.clientId, client_secret: config.google.clientSecret
      }) });
      if (typeof token.access_token !== 'string') throw new Error('Не получен токен входа');
      const user = await responseJson(fetcher, 'https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${token.access_token}` } });
      if (typeof user.sub !== 'string' || !user.sub) throw new Error('Не получен идентификатор аккаунта');
      return { subject: user.sub, name: user.name || 'Пользователь Google',
        ...(user.email_verified === true && typeof user.email === 'string'
          ? { verifiedEmail: user.email.trim().toLowerCase() } : {}) };
    }
  });
  if (config.vk.clientId) registry.set('vk', {
    label: 'VK',
    authorize: ({ state, challenge, redirectUri }) => authorize('https://id.vk.ru/authorize', {
      client_id: config.vk.clientId, redirect_uri: redirectUri, response_type: 'code', scope: '',
      state, code_challenge: challenge, code_challenge_method: 's256'
    }),
    async exchange({ code, verifier, redirectUri, state, deviceId }) {
      if (!deviceId || deviceId.length > 512) throw new Error('Не получен идентификатор устройства VK');
      const token = await responseJson(fetcher, 'https://id.vk.ru/oauth2/auth', { method: 'POST', body: new URLSearchParams({
        grant_type: 'authorization_code', client_id: config.vk.clientId, redirect_uri: redirectUri,
        code, code_verifier: verifier, state, device_id: deviceId
      }) });
      if (token.state !== state || typeof token.access_token !== 'string') throw new Error('Некорректный ответ VK');
      const result = await responseJson(fetcher, 'https://id.vk.ru/oauth2/user_info', { method: 'POST', body: new URLSearchParams({ client_id: config.vk.clientId, access_token: token.access_token }) });
      if (!result.user?.user_id) throw new Error('Не получен идентификатор аккаунта VK');
      return { subject: String(result.user.user_id), name: [result.user.first_name, result.user.last_name].filter(Boolean).join(' ') || 'Пользователь VK' };
    }
  });
  if (config.yandex?.clientId && config.yandex?.clientSecret) registry.set('yandex', {
    label: 'Яндекс',
    authorize: ({ state, challenge, redirectUri }) => authorize('https://oauth.yandex.ru/authorize', {
      client_id: config.yandex.clientId, redirect_uri: redirectUri, response_type: 'code',
      state, code_challenge: challenge, code_challenge_method: 'S256'
    }),
    async exchange({ code, verifier }) {
      const token = await responseJson(fetcher, 'https://oauth.yandex.ru/token', { method: 'POST', body: new URLSearchParams({
        grant_type: 'authorization_code', code, code_verifier: verifier,
        client_id: config.yandex.clientId, client_secret: config.yandex.clientSecret
      }) });
      if (typeof token.access_token !== 'string') throw new Error('Не получен токен входа');
      const user = await responseJson(fetcher, 'https://login.yandex.ru/info', { headers: { Authorization: `OAuth ${token.access_token}` } });
      if (String(user.client_id) !== config.yandex.clientId || !user.id) throw new Error('Некорректный аккаунт Яндекса');
      return { subject: String(user.id), name: [user.first_name, user.last_name].filter(Boolean).join(' ') || user.login || 'Пользователь Яндекса' };
    }
  });
  if (config.telegram?.clientId && config.telegram?.clientSecret) registry.set('telegram', {
    label: 'Telegram',
    authorize: ({ state, challenge, redirectUri }) => authorize('https://oauth.telegram.org/auth', {
      client_id: config.telegram.clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid profile',
      state, code_challenge: challenge, code_challenge_method: 'S256'
    }),
    async exchange({ code, verifier, redirectUri }) {
      const token = await responseJson(fetcher, 'https://oauth.telegram.org/token', { method: 'POST',
        headers: { Authorization: `Basic ${Buffer.from(`${config.telegram.clientId}:${config.telegram.clientSecret}`).toString('base64')}` },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri,
          client_id: config.telegram.clientId, code_verifier: verifier }) });
      return verifyTelegramIdToken(token.id_token, config.telegram.clientId, fetcher);
    }
  });
  return registry;
}
module.exports = { createProviders };
