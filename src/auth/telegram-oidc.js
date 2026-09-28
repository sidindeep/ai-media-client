const { createPublicKey, verify } = require('node:crypto');

async function verifyTelegramIdToken(idToken, clientId, fetcher = fetch) {
  if (typeof idToken !== 'string' || idToken.length > 16000) throw new Error('Некорректный Telegram ID token');
  const parts = idToken.split('.');
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error('Некорректный Telegram ID token');
  let header, claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch { throw new Error('Некорректный Telegram ID token'); }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) throw new Error('Неподдерживаемая подпись Telegram');
  const response = await fetcher('https://oauth.telegram.org/.well-known/jwks.json', { signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!response.ok) throw new Error('Ключи Telegram недоступны');
  const jwks = await response.json();
  const jwk = jwks.keys?.find(key => key.kid === header.kid && key.kty === 'RSA' && (!key.use || key.use === 'sig') && (!key.alg || key.alg === 'RS256'));
  if (!jwk || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'))) {
    throw new Error('Подпись Telegram не подтверждена');
  }
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== 'https://oauth.telegram.org' || String(claims.aud) !== String(clientId)
    || !Number.isInteger(claims.iat) || claims.iat > now + 60
    || !Number.isInteger(claims.exp) || claims.exp <= now
    || typeof claims.sub !== 'string' || !claims.sub) throw new Error('Некорректные данные Telegram');
  return { subject: claims.sub, name: typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim() : 'Пользователь Telegram' };
}

module.exports = { verifyTelegramIdToken };
