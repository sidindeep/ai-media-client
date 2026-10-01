// Read provider catalogues/prices only. Never sends generations or uploads.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createModelRouteSynchronizer } = require('../src/services/model-route-sync');
async function main() {
  const snapshot = process.argv.includes('--snapshot');
  const root = path.resolve(__dirname, '..');
  let pool;
  try {
    const document = snapshot ? JSON.parse(await fs.readFile(path.join(root, 'config/model-routes.json'), 'utf8'))
      : await (async () => {
        const { loadConfig } = require('../src/server/config');
        pool = await require('../src/database/database').openDatabase({ ...loadConfig(process.env).database, migrate: false });
        return require('../src/services/service-model-configs').readRouteDocument(pool);
      })();
    const result = await createModelRouteSynchronizer({ pool, apiKey: process.env.APIMART_API_KEY })(document, { force: true });
    if (snapshot) {
      result.version = `${new Date().toISOString().slice(0, 10)}-unified-2`;
      await fs.writeFile(path.join(root, 'config/model-routes.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
      require('./sync-model-routes.cjs');
    }
    console.log(JSON.stringify({ rows: result.models.length,
      priced: result.models.filter(row => Object.values(row.publishedTariffs).some(require('../src/services/model-route-sync').hasPrice)).length,
      added: result.models.length - document.models.length, snapshot }));
  } finally { if (pool) await pool.end(); }
}
main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
