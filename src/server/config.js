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
  const replicaRole = env.MEDIA_REPLICA_ROLE || 'single';
  if (!['single', 'executor', 'web'].includes(replicaRole)) throw new Error('Неизвестная роль реплики');
  let executorUrl = null;
  if (replicaRole === 'web') {
    if (!env.MEDIA_EXECUTOR_URL) throw new Error('Для web-реплики нужен MEDIA_EXECUTOR_URL');
    executorUrl = new URL(env.MEDIA_EXECUTOR_URL);
    if (!['http:', 'https:'].includes(executorUrl.protocol) || executorUrl.username || executorUrl.password
      || executorUrl.pathname !== '/' || executorUrl.search || executorUrl.hash) throw new Error('MEDIA_EXECUTOR_URL должен быть origin владельца исполнения');
  }
  const executorPublicOrigin = env.MEDIA_EXECUTOR_PUBLIC_ORIGIN || env.MEDIA_PUBLIC_ORIGIN || executorUrl?.origin || '';
  if (replicaRole === 'web' && (!['http:', 'https:'].includes(new URL(executorPublicOrigin).protocol)
    || new URL(executorPublicOrigin).origin !== executorPublicOrigin)) throw new Error('MEDIA_EXECUTOR_PUBLIC_ORIGIN должен быть origin владельца');
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
  const offersFile = path.resolve(root, env.MEDIA_PRODUCT_OFFERS_FILE || 'config/product-offers.json');
  const offersRelative = path.relative(root, offersFile);
  if (offersRelative.startsWith('..') || path.isAbsolute(offersRelative) || !fs.existsSync(offersFile)) throw new Error('Файл платных предложений должен находиться внутри проекта');
  const storageDriver = env.MEDIA_STORAGE_DRIVER || 'local';
  if (!['local', 's3'].includes(storageDriver)) throw new Error('MEDIA_STORAGE_DRIVER должен быть local или s3');
  const s3Values = ['MEDIA_S3_ENDPOINT', 'MEDIA_S3_BUCKET', 'MEDIA_S3_ACCESS_KEY', 'MEDIA_S3_SECRET_KEY'];
  if (storageDriver === 's3' && s3Values.some(name => !env[name])) throw new Error(`Для S3 нужны ${s3Values.join(', ')}`);
  if (env.MEDIA_S3_FORCE_PATH_STYLE && !['true', 'false'].includes(env.MEDIA_S3_FORCE_PATH_STYLE)) throw new Error('MEDIA_S3_FORCE_PATH_STYLE должен быть true или false');
  for (const name of ['MEDIA_SALES_ENABLED', 'MEDIA_PAYMENTS_ENABLED']) {
    if (env[name] && !['true', 'false'].includes(env[name])) throw new Error(`${name} должен быть true или false`);
  }
  const paymentEnvironment = env.MEDIA_PAYMENTS_ENVIRONMENT || 'test';
  if (!['test', 'live'].includes(paymentEnvironment)) throw new Error('MEDIA_PAYMENTS_ENVIRONMENT должен быть test или live');
  const requestedPaymentProvider = env.MEDIA_PAYMENTS_PROVIDER || 'yookassa';
  const paymentProvider = requestedPaymentProvider === 'yookassa' && paymentEnvironment === 'test'
    && (!env.YOOKASSA_SHOP_ID || !env.YOOKASSA_SECRET_KEY) ? 'yookassa-stub' : requestedPaymentProvider;
  if (!['yookassa', 'yookassa-stub'].includes(paymentProvider)) throw new Error('Неизвестный платёжный провайдер');
  if (paymentProvider === 'yookassa-stub' && paymentEnvironment !== 'test') throw new Error('Заглушка ЮKassa доступна только в test');
  if (env.MEDIA_SALES_ENABLED === 'true' && env.MEDIA_PAYMENTS_ENABLED !== 'true') throw new Error('Продажи нельзя включить без платёжного модуля');
  const smtpPort = Number(env.MEDIA_SMTP_PORT || 587);
  const smtpPortValid = Number.isInteger(smtpPort) && smtpPort >= 1 && smtpPort <= 65535;
  const emailEnabled = env.MEDIA_EMAIL_AUTH_ENABLED === 'true' && smtpPortValid
    && ['MEDIA_SMTP_HOST', 'MEDIA_SMTP_USER', 'MEDIA_SMTP_PASSWORD', 'MEDIA_SMTP_FROM']
      .every(name => Boolean((env[name] || '').trim()));
  const maxBotName = (env.MAX_LOGIN_BOT_NAME || '').trim();
  const maxBotToken = (env.MAX_LOGIN_BOT_TOKEN || '').trim();
  const maxTokenPlaceholder = /^(?:token|test|example|placeholder|changeme|your[_-]?(?:bot[_-]?)?token(?:[_-]?here)?|x{3,})$/i.test(maxBotToken);
  const maxLoginConfigured = /^[A-Za-z0-9_]{3,64}$/.test(maxBotName)
    && Boolean(maxBotToken) && !maxTokenPlaceholder && !/\s/.test(maxBotToken);
  const maxLoginInvalid = Boolean(maxBotName || maxBotToken) && !maxLoginConfigured;
  return {
    root, host, port, dataDirectory, replicaRole, executorUrl: executorUrl?.origin || '', executorPublicOrigin,
    kieKey: env.KIE_API_KEY || '', kieSecondaryKey: env.KIE_API_KEY_2 || '',
    uploadLimit: integer(env.MEDIA_UPLOAD_LIMIT_MB, 64, 1, 512) * 1024 * 1024,
    uploadInFlightLimit: integer(env.MEDIA_UPLOAD_INFLIGHT_MB, 256, 1, 4096) * 1024 * 1024,
    contentStagingLimit: integer(env.MEDIA_CONTENT_STAGING_MB, 1024, 1, 16384) * 1024 * 1024,
    telegram: { enabled: telegramEnabled, token: env.TELEGRAM_BOT_TOKEN || '', users: telegramUsers, publicAccess: telegramPublicAccess },
    publicOrigin: env.MEDIA_PUBLIC_ORIGIN || '',
    rubPerCredit, pricing, starterPack,
    commerce: { offersFile, salesEnabled: env.MEDIA_SALES_ENABLED === 'true' },
    payments: {
      enabled: env.MEDIA_PAYMENTS_ENABLED === 'true', environment: paymentEnvironment,
      clientId: env.MEDIA_PAYMENTS_CLIENT_ID || 'ai-media-client', provider: paymentProvider,
      yooKassa: { shopId: env.YOOKASSA_SHOP_ID || '', secretKey: env.YOOKASSA_SECRET_KEY || '' },
    },
    routerAi: { apiKey: env.ROUTERAI_API_KEY || '' },
    apimart: { apiKey: env.APIMART_API_KEY || '' },
    kieBrowser: {
      embedded: env.MEDIA_KIE_BROWSER_EMBEDDED === 'true',
      cdpUrl: env.MEDIA_KIE_BROWSER_CDP || (env.MEDIA_KIE_BROWSER_EMBEDDED === 'true' ? 'http://127.0.0.1:9222' : ''),
      loginUrl: env.MEDIA_KIE_BROWSER_LOGIN_URL || '',
      idleMinutes: integer(env.MEDIA_KIE_BROWSER_IDLE_MINUTES, 5, 1, 60),
    },
    codex: { url: env.MEDIA_CODEX_URL || (env.MEDIA_CODEX_EMBEDDED === 'true' ? 'http://127.0.0.1:3210' : ''),
      embedded: env.MEDIA_CODEX_EMBEDDED === 'true' && !env.MEDIA_CODEX_URL },
    database: { url: env.DATABASE_URL || '', ssl: env.DATABASE_SSL === '1',
      poolMax: integer(env.MEDIA_DB_POOL_MAX, 5, 1, 30), migrate: env.MEDIA_DB_MIGRATE !== 'false' },
    sse: { maxConnections: integer(env.MEDIA_SSE_MAX_CONNECTIONS, 100, 1, 1000),
      maxPerAccount: integer(env.MEDIA_SSE_MAX_PER_ACCOUNT, 8, 1, 100) },
    storage: {
      enabled: storageDriver === 's3', driver: storageDriver,
      endpoint: env.MEDIA_S3_ENDPOINT || '', bucket: env.MEDIA_S3_BUCKET || '', region: env.MEDIA_S3_REGION || 'ru-1',
      accessKey: env.MEDIA_S3_ACCESS_KEY || '', secretKey: env.MEDIA_S3_SECRET_KEY || '',
      forcePathStyle: env.MEDIA_S3_FORCE_PATH_STYLE !== 'false',
    },
    auth: { enabled: authEnabled, origin: authOrigin,
      sessionSeconds: integer(env.MEDIA_SESSION_SECONDS, 604800, 300, 2592000),
      adminIdentities: (env.MEDIA_ADMIN_IDENTITIES || '').split(',').map(s => s.trim()).filter(Boolean),
      google: { clientId: env.GOOGLE_CLIENT_ID || '', clientSecret: env.GOOGLE_CLIENT_SECRET || '' },
      vk: { clientId: env.VK_CLIENT_ID || '' },
      yandex: { clientId: env.YANDEX_CLIENT_ID || '', clientSecret: env.YANDEX_CLIENT_SECRET || '' },
      telegram: { clientId: env.TELEGRAM_LOGIN_CLIENT_ID || '', clientSecret: env.TELEGRAM_LOGIN_CLIENT_SECRET || '' },
      email: { enabled: emailEnabled, smtp: { host: env.MEDIA_SMTP_HOST || '', port: smtpPortValid ? smtpPort : 587,
        user: env.MEDIA_SMTP_USER || '', password: env.MEDIA_SMTP_PASSWORD || '', from: env.MEDIA_SMTP_FROM || '' } },
      max: { botName: maxLoginConfigured ? maxBotName : '', botToken: maxLoginConfigured ? maxBotToken : '', invalid: maxLoginInvalid }
    }
  };
}
module.exports = { loadConfig };
