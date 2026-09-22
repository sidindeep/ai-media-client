const fs = require('node:fs/promises');
const path = require('node:path');
const { loadConfig } = require('./src/server/config');
const { createHttpServer } = require('./src/server/http');
const { createKieAccounts } = require('./src/services/kie-accounts');
const { createMediaService } = require('./src/services/media-service');
const { createTelegramGateway } = require('./src/services/telegram-gateway');
const { openDatabase } = require('./src/database/database');
const { createDatabaseAvailability } = require('./src/database/availability');
const { createAuth } = require('./src/auth/service');
const { createAccounts } = require('./src/services/accounts');
const { createCodexWorker } = require('./src/services/codex-worker');
const { createStarterPack } = require('./src/billing/starter-pack');
const { createObjectStorage } = require('./src/object-storage');
const { createContentService } = require('./src/services/content-service');
const { createPayments } = require('./src/payments/service');
const { createYooKassaProvider } = require('./src/payments/providers/yookassa');
const { createProductCatalog } = require('./src/commerce/catalog');
const { createCommerce } = require('./src/commerce/service');

function startupDiagnosticRequest(service) {
  const catalog = service.catalog();
  const model = catalog.models.find(item => item.startupDefault && item.kind === 'image')
    || catalog.models.find(item => item.kind === 'image')
    || catalog.models[0];
  if (!model) throw new Error('Каталог Kie пуст');
  const input = { prompt: 'Проверка готовности Kie' };
  for (const field of model.fields || []) {
    if (/prompt/i.test(field.key) || field.type === 'files') continue;
    const firstOption = field.options?.[0] ?? field.schema?.enum?.[0];
    if (field.default !== undefined) input[field.key] = field.default;
    else if (firstOption !== undefined) input[field.key] = firstOption;
  }
  return { model, input };
}

async function checkProviderReadiness(service, readiness) {
  readiness.provider = { state: 'checking', startedAt: new Date().toISOString() };
  try {
    const { model, input } = startupDiagnosticRequest(service);
    const result = await service.diagnoseProvider(model.id, input);
    readiness.provider = {
      state: result.ok ? 'ready' : 'error', checkedAt: result.checkedAt,
      model: result.model, quote: result.quote,
      checks: result.checks.map(item => ({ step: item.step, status: item.status, durationMs: item.durationMs })),
    };
  } catch (error) {
    readiness.provider = { state: 'error', checkedAt: new Date().toISOString(), error: error instanceof Error ? error.message : 'Проверка Kie не выполнена' };
  }
}

async function start({ config = loadConfig(), provider, paymentProvider, pool: suppliedPool, authProviders, startupChecks = !suppliedPool, databaseOpener = openDatabase, tariffFetcher } = {}) {
  if (config.auth.enabled && !config.database.url && !suppliedPool) throw new Error('Для аккаунтов настройте DATABASE_URL. Локальный режим владельца: MEDIA_AUTH_ENABLED=false');
  await fs.mkdir(config.dataDirectory, { recursive: true });
  // Hosting mounts /app/data after image build, hiding directories created there.
  if (config.codex?.embedded && process.env.CODEX_HOME) {
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true, mode: 0o700 });
  }
  const lockPath = path.join(config.dataDirectory, 'service.lock');
  let lock;
  try { lock = await fs.open(lockPath, 'wx'); await lock.writeFile(String(process.pid)); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Хранилище занято другим сервисом. После аварийной остановки удалите service.lock, убедившись, что процесс завершён.');
    throw error;
  }
  let service, telegram, server, pool, accounts, auth, content, codexWorker, databaseTask, payments, commerce, paymentTimer;
  const storage = createObjectStorage(config.storage);
  let closing = false, retryTimer, wakeRetry;
  const databaseAvailability = createDatabaseAvailability({ state: config.auth.enabled ? 'connecting' : 'disabled' });
  const readiness = {
    provider: { state: startupChecks ? 'checking' : 'idle' },
  };
  Object.defineProperty(readiness, 'database', { enumerable: true, get: () => databaseAvailability.snapshot() });
  const createBusinessServices = async activePool => {
    if (!config.payments?.enabled) return { payments: null, commerce: null };
    const activePaymentProvider = paymentProvider || (config.payments.provider === 'yookassa'
      ? createYooKassaProvider({ ...config.payments.yooKassa, environment: config.payments.environment })
      : null);
    if (!activePaymentProvider) throw new Error('Платёжный провайдер не поддерживается');
    let nextCommerce;
    const nextPayments = createPayments({ pool: activePool, provider: activePaymentProvider, onEvent: event => nextCommerce.handlePaymentEvent(event) });
    nextCommerce = createCommerce({ pool: activePool, catalog: createProductCatalog(config.commerce.offersFile), paymentClient: nextPayments,
      paymentContext: { clientId: config.payments.clientId, environment: config.payments.environment },
      onPurchase: accountId => accounts?.notifyContent(accountId) });
    await nextPayments.deliver();
    return { payments: nextPayments, commerce: nextCommerce };
  };
  const waitForRetry = delay => new Promise(resolve => {
    wakeRetry = resolve;
    retryTimer = setTimeout(() => { retryTimer = undefined; wakeRetry = undefined; resolve(); }, delay);
  });
  const cleanup = async () => {
    closing = true;
    databaseAvailability.close();
    if (retryTimer) clearTimeout(retryTimer);
    if (paymentTimer) clearInterval(paymentTimer);
    wakeRetry?.();
    await telegram?.stop();
    server?.closeEvents();
    if (codexWorker) {
      codexWorker.stopActive(); codexWorker.closeAllConnections();
      if (codexWorker.listening) await new Promise(resolve => codexWorker.close(resolve));
    }
    if (server?.listening) { server.closeIdleConnections(); await new Promise(resolve => server.close(resolve)); }
    await service?.close();
    await accounts?.close();
    await content?.close();
    await pool?.end();
    await lock.close(); await fs.unlink(lockPath).catch(() => {});
  };
  try {
    provider = provider || await createKieAccounts({ primaryKey: config.kieKey, secondaryKey: config.kieSecondaryKey });
    if (storage) await storage.check();
    service = await createMediaService({ directory: config.dataDirectory, provider, rubPerCredit: config.rubPerCredit, tariffFetcher, storage, storagePrefix: 'legacy' });
    if (config.auth.enabled && suppliedPool) {
      pool = await databaseOpener(config.database, suppliedPool);
      content = await createContentService({ pool, storage, dataDirectory: config.dataDirectory, onChange: accountId => accounts?.notifyContent(accountId) });
      const starterPack = createStarterPack({ pool, config: config.starterPack });
      auth = createAuth({ pool, config: config.auth, providers: authProviders, starterPack });
      accounts = createAccounts({ pool, config, provider, legacy: service, tariffFetcher, starterPack, storage, content });
      await accounts.recover();
      ({ payments, commerce } = await createBusinessServices(pool));
      if (payments) paymentTimer = setInterval(() => payments.deliver().catch(error => console.error('Payment outbox delivery failed:', error.code || error.message)), 5000);
      databaseAvailability.update({ state: 'connected', connectedAt: new Date().toISOString() });
    }
    if (config.codex?.embedded) {
      codexWorker = createCodexWorker();
      await new Promise((resolve, reject) => {
        codexWorker.once('error', reject);
        codexWorker.listen(3210, '127.0.0.1', resolve);
      });
      console.log('Codex worker ready on loopback');
    }
    // Legacy Telegram has no account binding yet: never bypass the wallet via the bot.
    const telegramConfig = config.auth.enabled ? { ...config.telegram, enabled: false } : config.telegram;
    telegram = createTelegramGateway({ service, config: telegramConfig, directory: config.dataDirectory });
    const telegramStatus = () => ({ ...telegram.status(), ...(config.auth.enabled && config.telegram.enabled ? { disabledReason: 'account-linking-required' } : {}) });
    server = createHttpServer({ config, service, auth, accounts, readiness, databaseAvailability, telegramStatus, storage, payments, commerce });
    await server.recoverCodex();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
    telegram.start();
    if (startupChecks) void checkProviderReadiness(service, readiness);
    if (config.auth.enabled && !accounts) {
      databaseTask = (async () => {
        let attempt = 0;
        while (!closing && !accounts) {
          attempt++;
          databaseAvailability.update({ state: 'connecting', attempt, startedAt: new Date().toISOString() });
          let nextPool, nextAccounts, nextContent;
          try {
            nextPool = await databaseOpener(config.database);
            nextContent = await createContentService({ pool: nextPool, storage, dataDirectory: config.dataDirectory, onChange: accountId => accounts?.notifyContent(accountId) });
            const starterPack = createStarterPack({ pool: nextPool, config: config.starterPack });
            const nextAuth = createAuth({ pool: nextPool, config: config.auth, providers: authProviders, starterPack });
            nextAccounts = createAccounts({ pool: nextPool, config, provider, legacy: service, tariffFetcher, starterPack, storage, content: nextContent });
            await nextAccounts.recover();
            if (closing) { await nextAccounts.close(); await nextContent?.close(); await nextPool.end(); return; }
            pool = nextPool; auth = nextAuth; content = nextContent; accounts = nextAccounts;
            ({ payments, commerce } = await createBusinessServices(pool));
            if (paymentTimer) clearInterval(paymentTimer);
            if (payments) paymentTimer = setInterval(() => payments.deliver().catch(error => console.error('Payment outbox delivery failed:', error.code || error.message)), 5000);
            await server.setAccountServices(auth, accounts, payments, commerce);
            databaseAvailability.update({ state: 'connected', connectedAt: new Date().toISOString() });
          } catch (error) {
            if (nextAccounts) await nextAccounts.close().catch(() => {});
            if (nextContent) await nextContent.close().catch(() => {});
            if (nextPool) await nextPool.end().catch(() => {});
            const retryInMs = Math.min(10000, 1000 * (2 ** Math.min(attempt - 1, 4)));
            databaseAvailability.update({ state: 'unavailable', code: error.code || 'CONNECTION_TIMEOUT', attempt, retryInMs });
            console.error('Database background retry:', error.code || error.message || 'CONNECTION_TIMEOUT');
            if (!closing) await waitForRetry(retryInMs);
          }
        }
      })();
    }
    return { server, service, telegram, readiness, get accounts() { return accounts; }, get auth() { return auth; }, databaseTask, close: cleanup };
  } catch (error) { await cleanup(); throw error; }
}
if (require.main === module) {
  start().then(runtime => {
    const address = runtime.server.address();
    console.log(`AI Media web: http://${address.address}:${address.port}`);
    let closing = false;
    const close = () => { if (closing) return; closing = true; void runtime.close().then(() => process.exit(0)); };
    process.once('SIGINT', close); process.once('SIGTERM', close);
  }).catch(error => { console.error(error.code ? 'Не удалось запустить сервис: ' + error.code : error.message); process.exitCode = 1; });
}
module.exports = { start };
