const path = require('node:path');
const root = path.resolve(__dirname, '../..');
function integer(value, fallback, min, max) {
  const number = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error('Некорректный числовой параметр сервиса');
  return number;
}
function loadConfig(env = process.env) {
  const host = env.MEDIA_HOST || '127.0.0.1';
  const port = integer(env.MEDIA_PORT, 3000, 0, 65535);
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
  return {
    root, host, port, dataDirectory, kieKey: env.KIE_API_KEY || '',
    uploadLimit: integer(env.MEDIA_UPLOAD_LIMIT_MB, 64, 1, 512) * 1024 * 1024,
    telegram: { enabled: telegramEnabled, token: env.TELEGRAM_BOT_TOKEN || '', users: telegramUsers, publicAccess: telegramPublicAccess },
    publicOrigin: env.MEDIA_PUBLIC_ORIGIN || '',
    rubPerCredit
  };
}
module.exports = { loadConfig };
