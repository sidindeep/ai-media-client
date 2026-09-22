const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { loadConfig } = require('../src/server/config');
const { openDatabase } = require('../src/database/database');
const { createObjectStorage } = require('../src/object-storage');
const { createContentService } = require('../src/services/content-service');

async function hashStream(stream) {
  const hash = createHash('sha256'); let size = 0;
  for await (const chunk of stream) { size += chunk.length; hash.update(chunk); }
  return { size, sha256: hash.digest('hex') };
}
async function localFile(filename) {
  try { const stat = await fs.stat(filename); return stat.isFile() ? stat : null; } catch { return null; }
}

async function main() {
  const config = loadConfig();
  if (!config.database.url) throw new Error('DATABASE_URL не настроен');
  const storage = createObjectStorage(config.storage);
  if (!storage) throw new Error('S3-хранилище не настроено');
  await storage.check();
  const pool = await openDatabase(config.database);
  const content = await createContentService({ pool, storage, dataDirectory: config.dataDirectory });
  const report = { sources: 0, results: 0, codex: 0, ready: 0, missing: 0, uploaded: 0, linked: 0 };
  const rows = (await pool.query("SELECT account_id::text,namespace,id,data FROM media_records WHERE namespace IN ('sources','history','codex') ORDER BY account_id,namespace,id")).rows;
  const sourceAssets = new Map();
  async function describe(storageKey, filename, expectedType, expectedHash) {
    let head = await storage.head(storageKey).catch(() => null);
    if (!head && filename && await localFile(filename)) {
      const stat = await fs.stat(filename);
      await storage.put(storageKey, createReadStream(filename), expectedType, stat.size);
      head = await storage.head(storageKey); report.uploaded++;
    }
    if (!head) return { status: 'missing', size: null, sha256: expectedHash || null, type: expectedType, error: 'Байты legacy-файла не найдены на этом экземпляре и в S3' };
    const remote = await storage.stream(storageKey);
    const measured = await hashStream(remote.body);
    return { status: 'ready', size: measured.size, sha256: measured.sha256, type: expectedType || head.type };
  }
  async function register(accountId, details) {
    const state = await describe(details.storageKey, details.filename, details.type, details.sha256);
    const asset = await content.register(accountId, { ...details, ...state });
    report[state.status]++;
    return asset;
  }
  try {
    for (const row of rows.filter(item => item.namespace === 'sources')) {
      const data = row.data || {}, hash = String(data.ref || '').split('/').pop();
      if (!/^[a-f0-9]{64}$/.test(hash)) continue;
      const storageKey = `accounts/${row.account_id}/sources/${hash}`;
      const filename = path.join(config.dataDirectory, 'accounts', row.account_id, 'sources', hash);
      const asset = await register(row.account_id, { storageKey, filename, name: data.name || 'source', type: data.type || 'application/octet-stream', sha256: hash, origin: { kind: 'legacy-source', recordId: row.id } });
      sourceAssets.set(`${row.account_id}:${data.ref}`, asset.id);
      if (data.assetId !== asset.id) await pool.query("UPDATE media_records SET data=data||$4::jsonb,updated_at=now() WHERE account_id=$1 AND namespace=$2 AND id=$3", [row.account_id, 'sources', row.id, JSON.stringify({ assetId: asset.id })]);
      report.sources++;
    }
    for (const row of rows.filter(item => item.namespace === 'history')) {
      const data = row.data || {}, files = [...(data.localFiles || [])]; let changed = false;
      for (const [index, file] of files.entries()) {
        if (file.assetId) { await content.link(row.account_id, 'history', row.id, file.assetId, 'result', index).catch(() => {}); continue; }
        const storageKey = file.storageKey || `accounts/${row.account_id}/results/${row.id}/${index}${path.extname(file.path || file.name || '') || '.bin'}`;
        const asset = await register(row.account_id, { storageKey, filename: file.path, name: file.name || path.basename(file.path || storageKey), type: file.type || 'application/octet-stream', origin: { kind: 'legacy-result', recordId: row.id, position: index } });
        files[index] = { ...file, assetId: asset.id }; changed = true; report.results++;
        await content.link(row.account_id, 'history', row.id, asset.id, 'result', index); report.linked++;
      }
      for (const [index, source] of (data.sourceFiles || []).entries()) {
        const assetId = sourceAssets.get(`${row.account_id}:${source.ref}`);
        if (assetId) { await content.link(row.account_id, 'history', row.id, assetId, 'source', index); report.linked++; }
      }
      if (changed) await pool.query("UPDATE media_records SET data=data||$4::jsonb,updated_at=now() WHERE account_id=$1 AND namespace=$2 AND id=$3", [row.account_id, 'history', row.id, JSON.stringify({ localFiles: files })]);
    }
    for (const row of rows.filter(item => item.namespace === 'codex' && item.data?.state === 'success' && item.data?.hasImage)) {
      const requestId = row.data.requestId || row.data.id || row.id.split(':').pop();
      let assetId = row.data.contentAssetId;
      if (!assetId) {
        const storageKey = `accounts/${row.account_id}/codex-images/${requestId}.png`;
        const filename = path.join(config.dataDirectory, 'codex-images', row.account_id, requestId + '.png');
        const asset = await register(row.account_id, { storageKey, filename, name: requestId + '.png', type: 'image/png', origin: { kind: 'legacy-codex', recordId: row.id, position: 0 } });
        assetId = asset.id;
        await pool.query("UPDATE media_records SET data=data||$4::jsonb,updated_at=now() WHERE account_id=$1 AND namespace=$2 AND id=$3", [row.account_id, 'codex', row.id, JSON.stringify({ contentAssetId: assetId })]);
        report.codex++;
      }
      await content.link(row.account_id, 'codex', row.id, assetId, 'result', 0); report.linked++;
    }
    console.log(JSON.stringify(report, null, 2));
  } finally { await content.close(); await pool.end(); }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
