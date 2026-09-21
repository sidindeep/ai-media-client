const fs = require('node:fs/promises');
const path = require('node:path');
const { loadConfig } = require('./src/server/config');
const { createHttpServer } = require('./src/server/http');
const { createKieGeneration } = require('./src/services/kie-generation');
const { createMediaService } = require('./src/services/media-service');
const { createTelegramGateway } = require('./src/services/telegram-gateway');
const { openDatabase } = require('./src/database/database');
const { createDatabaseAvailability } = require('./src/database/availability');
const { createAuth } = require('./src/auth/service');
const { createAccounts } = require('./src/services/accounts');
const { createCodexWorker } = require('./src/services/codex-worker');

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

async function start({ config = loadConfig(), provider, pool: suppliedPool, authProviders, startupChecks = !suppliedPool, databaseOpener = openDatabase, tariffFetcher } = {}) {
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
  let service, telegram, server, pool, accounts, auth, codexWorker, databaseTask;
  let closing = false, retryTimer, wakeRetry;
  const databaseAvailability = createDatabaseAvailability({ state: config.auth.enabled ? 'connecting' : 'disabled' });
  const readiness = {
    provider: { state: startupChecks ? 'checking' : 'idle' },
  };
  Object.defineProperty(readiness, 'database', { enumerable: true, get: () => databaseAvailability.snapshot() });
  const waitForRetry = delay => new Promise(resolve => {
    wakeRetry = resolve;
    retryTimer = setTimeout(() => { retryTimer = undefined; wakeRetry = undefined; resolve(); }, delay);
  });
  const cleanup = async () => {
    closing = true;
    databaseAvailability.close();
    if (retryTimer) clearTimeout(retryTimer);
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
    await pool?.end();
    await lock.close(); await fs.unlink(lockPath).catch(() => {});
  };
  try {
    provider = provider || await createKieGeneration({ apiKey: config.kieKey });
    service = await createMediaService({ directory: config.dataDirectory, provider, rubPerCredit: config.rubPerCredit, tariffFetcher });
    if (config.auth.enabled && suppliedPool) {
      pool = await databaseOpener(config.database, suppliedPool);
      auth = createAuth({ pool, config: config.auth, providers: authProviders });
      accounts = createAccounts({ pool, config, provider, legacy: service, tariffFetcher });
      await accounts.recover();
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
    server = createHttpServer({ config, service, auth, accounts, readiness, databaseAvailability, telegramStatus });
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
          let nextPool, nextAccounts;
          try {
            nextPool = await databaseOpener(config.database);
            const nextAuth = createAuth({ pool: nextPool, config: config.auth, providers: authProviders });
            nextAccounts = createAccounts({ pool: nextPool, config, provider, legacy: service, tariffFetcher });
            await nextAccounts.recover();
            if (closing) { await nextAccounts.close(); await nextPool.end(); return; }
            pool = nextPool; auth = nextAuth; accounts = nextAccounts;
            await server.setAccountServices(auth, accounts);
            databaseAvailability.update({ state: 'connected', connectedAt: new Date().toISOString() });
          } catch (error) {
            if (nextAccounts) await nextAccounts.close().catch(() => {});
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
