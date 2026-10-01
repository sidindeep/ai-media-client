// Standalone Google adapter: no application, framework or storage dependencies.
function createGoogleProvider({ clientId, clientSecret, fetcher = fetch }) {
  if (typeof clientId !== 'string' || !clientId.trim()
    || typeof clientSecret !== 'string' || !clientSecret.trim()) throw new Error('Google OAuth credentials are required');
  async function json(url, options) {
    const response = await fetcher(url, { ...options, signal: AbortSignal.timeout(15000), redirect: 'error' });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error('Провайдер не подтвердил вход');
    return data;
  }
  return {
    label: 'Google',
    authorize({ state, challenge, redirectUri }) {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri,
        response_type: 'code', scope: 'openid profile email', state,
        code_challenge: challenge, code_challenge_method: 'S256' }).toString();
      return url.href;
    },
    async exchange({ code, verifier, redirectUri }) {
      const token = await json('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({
        grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri,
        client_id: clientId, client_secret: clientSecret }) });
      if (typeof token.access_token !== 'string') throw new Error('Не получен токен входа');
      const user = await json('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${token.access_token}` } });
      if (typeof user.sub !== 'string' || !user.sub) throw new Error('Не получен идентификатор аккаунта');
      return { subject: user.sub, name: user.name || 'Пользователь Google',
        ...(user.email_verified === true && typeof user.email === 'string'
          ? { verifiedEmail: user.email.trim().toLowerCase() } : {}) };
    },
  };
}

module.exports = { createGoogleProvider };
