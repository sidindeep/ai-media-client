const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '../..');
function integer(value, fallback, min, max) {
  const number = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error('Некорректный числовой параметр сервиса');
  return number;
}
function loadConfig(env = process.env) {
  const host = env.MEDIA_HOST || '127.0.0.1';
  const port = integer(env.MEDIA_PORT || env.PORT, 3000, 0, 65535);
  const dataDirectory = path.resolve(root, env.MEDIA_DATA_DIR || 'data/service');
  const relative = path.relative(root, dataDirectory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('MEDIA_DATA_DIR должен быть внутри проекта');
  const telegramUsers = (env.TELEGRAM_ALLOWED_USER_IDS || '').split(',').map(value => value.trim()).filter(Boolean);
  if (telegramUsers.some(value => !/^\d+$/.test(value))) throw new Error('Некорректный Telegram user ID');
  const telegramEnabled = env.TELEGRAM_ENABLED === 'true';
  const publicAccessValue = env.TELEGRAM_PUBLIC_ACCESS || 'true';
  if (!['true', 'false'].includes(publicAccessValue)) throw new Error('TELEGRAM_PUBLIC_ACCESS должен быть true или false');
  const telegramPublicAccess = publicAccessValue === 'true';
  const rubPerCredit = Number(env.MEDIA_RUB_PER_CREDIT || 0.51);
  if (!Number.isFinite(rubPerCredit) || rubPerCredit <= 0 || rubPerCredit > 100000) throw new Error('Некорректная цена кредита');
  if (env.MEDIA_PUBLIC_ORIGIN) {
    const origin = new URL(env.MEDIA_PUBLIC_ORIGIN);
    if (!['https:', 'http:'].includes(origin.protocol) || origin.origin !== env.MEDIA_PUBLIC_ORIGIN) throw new Error('MEDIA_PUBLIC_ORIGIN должен быть origin без пути');
  }
  if (telegramEnabled && !env.TELEGRAM_BOT_TOKEN) throw new Error('Для бота нужен TELEGRAM_BOT_TOKEN');
  if (env.MEDIA_AUTH_ENABLED && !['true', 'false'].includes(env.MEDIA_AUTH_ENABLED)) throw new Error('MEDIA_AUTH_ENABLED должен быть true или false');
  const authEnabled = env.MEDIA_AUTH_ENABLED !== 'false';
  if (!authEnabled && (!['127.0.0.1', 'localhost', '::1'].includes(host) || env.MEDIA_PUBLIC_ORIGIN)) throw new Error('Без авторизации разрешён только локальный режим без публичного origin');
  const authOrigin = env.MEDIA_PUBLIC_ORIGIN || `http://localhost:${port}`;
  if (authEnabled && !authOrigin.startsWith('https:') && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(authOrigin).hostname)) throw new Error('Для публичной авторизации требуется HTTPS');
  const pricingFile = path.resolve(root, env.MEDIA_PRICING_FILE || 'config/native-prices.json');
  const pricingRelative = path.relative(root, pricingFile);
  if (pricingRelative.startsWith('..') || path.isAbsolute(pricingRelative)) throw new Error('Файл цен должен быть внутри проекта');
  const pricing = fs.existsSync(pricingFile) ? JSON.parse(fs.readFileSync(pricingFile, 'utf8')) : { version: 'unpublished', models: {} };
  const starterPackFile = path.resolve(root, env.MEDIA_STARTER_PACK_FILE || 'config/starter-pack.json');
  const starterPackRelative = path.relative(root, starterPackFile);
  if (starterPackRelative.startsWith('..') || path.isAbsolute(starterPackRelative) || !fs.existsSync(starterPackFile)) throw new Error('Файл стартового пакета должен находиться внутри проекта');
  const starterPack = JSON.parse(fs.readFileSync(starterPackFile, 'utf8'));
  return {
    root, host, port, dataDirectory, kieKey: env.KIE_API_KEY || '',
    uploadLimit: integer(env.MEDIA_UPLOAD_LIMIT_MB, 64, 1, 512) * 1024 * 1024,
    telegram: { enabled: telegramEnabled, token: env.TELEGRAM_BOT_TOKEN || '', users: telegramUsers, publicAccess: telegramPublicAccess },
    publicOrigin: env.MEDIA_PUBLIC_ORIGIN || '',
    rubPerCredit, pricing, starterPack,
    codex: { url: env.MEDIA_CODEX_URL || (env.MEDIA_CODEX_EMBEDDED === 'true' ? 'http://127.0.0.1:3210' : ''),
      embedded: env.MEDIA_CODEX_EMBEDDED === 'true' && !env.MEDIA_CODEX_URL },
    database: { url: env.DATABASE_URL || '', ssl: env.DATABASE_SSL === '1' },
    auth: { enabled: authEnabled, origin: authOrigin,
      sessionSeconds: integer(env.MEDIA_SESSION_SECONDS, 604800, 300, 2592000),
      adminIdentities: (env.MEDIA_ADMIN_IDENTITIES || '').split(',').map(s => s.trim()).filter(Boolean),
      google: { clientId: env.GOOGLE_CLIENT_ID || '', clientSecret: env.GOOGLE_CLIENT_SECRET || '' },
      vk: { clientId: env.VK_CLIENT_ID || '' }
    }
  };
}
module.exports = { loadConfig };
