const fs = require('node:fs/promises');
const path = require('node:path');
const { loadConfig } = require('./src/server/config');
const { createHttpServer } = require('./src/server/http');
const { createKieGeneration } = require('./src/services/kie-generation');
const { createMediaService } = require('./src/services/media-service');
const { createTelegramGateway } = require('./src/services/telegram-gateway');
const { openDatabase } = require('./src/database/database');
const { createAuth } = require('./src/auth/service');
const { createAccounts } = require('./src/services/accounts');
const { createCodexWorker } = require('./src/services/codex-worker');

async function start({ config = loadConfig(), provider, pool: suppliedPool, authProviders } = {}) {
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
  let service, telegram, server, pool, accounts, auth, codexWorker;
  const cleanup = async () => {
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
    service = await createMediaService({ directory: config.dataDirectory, provider, rubPerCredit: config.rubPerCredit });
    if (config.auth.enabled) {
      pool = await openDatabase(config.database, suppliedPool);
      auth = createAuth({ pool, config: config.auth, providers: authProviders });
      accounts = createAccounts({ pool, config, provider, legacy: service });
      await accounts.recover();
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
    server = createHttpServer({ config, service, auth, accounts, telegramStatus });
    await server.recoverCodex();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
    telegram.start();
    return { server, service, telegram, accounts, auth, close: cleanup };
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
