const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../src/server/config');
const { openDatabase } = require('../src/database/database');
const { saveModelConfig, activateModelConfig, currentModelConfig, listModelConfigs } = require('../src/services/service-model-configs');

async function main() {
  const config = loadConfig(process.env);
  const fileArg = process.argv.slice(2).find(arg => !arg.startsWith('--'));
  const inactive = process.argv.includes('--inactive');
  const source = path.resolve(fileArg || path.join(config.root, 'config/service-models.json'));
  const models = JSON.parse(fs.readFileSync(source, 'utf8'));
  const pool = await openDatabase({ ...config.database, migrate: false });
  try {
    const id = await saveModelConfig(pool, models);
    if (!inactive) await activateModelConfig(pool, id);
    const current = await currentModelConfig(pool);
    const saved = (await listModelConfigs(pool)).find(item => item.id === id);
    if (!saved || saved.modelCount !== models.models.length || (!inactive && current?.id !== id))
      throw new Error('Конфигурация моделей не подтверждена');
    process.stdout.write(JSON.stringify({ id, rows: saved.modelCount, isCurrent: saved.isCurrent,
      currentId: current?.id || null }) + '\n');
  } finally { await pool.end(); }
}
main().catch(error => { process.stderr.write(`${error.code || error.message}\n`); process.exitCode = 1; });
