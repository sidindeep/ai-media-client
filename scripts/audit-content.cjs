const { loadConfig } = require('../src/server/config');
const { openDatabase } = require('../src/database/database');
const { createObjectStorage } = require('../src/object-storage');

async function main() {
  const config = loadConfig();
  if (!config.database.url) throw new Error('DATABASE_URL не настроен');
  const storage = createObjectStorage(config.storage);
  if (!storage) throw new Error('S3-хранилище не настроено');
  const pool = await openDatabase(config.database);
  try {
    const assets = (await pool.query('SELECT status,storage_key,size_bytes FROM content_assets')).rows;
    const registered = new Set(assets.map(item => item.storage_key));
    const report = { assets: assets.length, ready: 0, missing: 0, failed: 0, saving: 0, readyAbsent: 0, sizeMismatch: 0, recoveredMissing: 0, orphanObjects: 0 };
    for (const asset of assets) {
      report[asset.status]++;
      const head = await storage.head(asset.storage_key).catch(() => null);
      if (asset.status === 'ready' && !head) report.readyAbsent++;
      if (asset.status === 'ready' && head && asset.size_bytes != null && head.size !== Number(asset.size_bytes)) report.sizeMismatch++;
      if (asset.status === 'missing' && head) report.recoveredMissing++;
    }
    const objects = await storage.list('accounts/');
    report.orphanObjects = objects.filter(item => !registered.has(item.key)).length;
    console.log(JSON.stringify(report, null, 2));
  } finally { await pool.end(); }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
