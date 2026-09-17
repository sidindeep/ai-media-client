const fs = require('node:fs/promises');
const path = require('node:path');
const { loadConfig } = require('./src/server/config');
const { createHttpServer } = require('./src/server/http');
const { createKieGeneration } = require('./src/services/kie-generation');
const { createMediaService } = require('./src/services/media-service');
const { createTelegramGateway } = require('./src/services/telegram-gateway');

async function start({ config = loadConfig(), provider } = {}) {
  await fs.mkdir(config.dataDirectory, { recursive: true });
  const lockPath = path.join(config.dataDirectory, 'service.lock');
  let lock;
  try { lock = await fs.open(lockPath, 'wx'); await lock.writeFile(String(process.pid)); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Хранилище занято другим сервисом. После аварийной остановки удалите service.lock, убедившись, что процесс завершён.');
    throw error;
  }
  let service, telegram, server;
  const cleanup = async () => {
    await telegram?.stop();
    server?.closeEvents();
    if (server?.listening) { server.closeIdleConnections(); await new Promise(resolve => server.close(resolve)); }
    await service?.close();
    await lock.close(); await fs.unlink(lockPath).catch(() => {});
  };
  try {
    service = await createMediaService({ directory: config.dataDirectory, provider: provider || await createKieGeneration({ apiKey: config.kieKey }), rubPerCredit: config.rubPerCredit });
    telegram = createTelegramGateway({ service, config: config.telegram, directory: config.dataDirectory });
    server = createHttpServer({ config, service, telegramStatus: telegram.status });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
    telegram.start();
    return { server, service, telegram, close: cleanup };
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
