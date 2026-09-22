const fs = require('node:fs/promises');
const { createReadStream, createWriteStream } = require('node:fs');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createHash, randomUUID } = require('node:crypto');
const { transaction } = require('../database/database');

const UUID = /^[a-f0-9-]{36}$/;
const TYPES = /^(?:image\/(?:png|jpeg|webp|gif)|video\/(?:mp4|webm|quicktime)|audio\/[a-z0-9.+-]+)$/;
const EXTENSIONS = new Map([
  ['image/png', '.png'], ['image/jpeg', '.jpg'], ['image/webp', '.webp'], ['image/gif', '.gif'],
  ['video/mp4', '.mp4'], ['video/webm', '.webm'], ['video/quicktime', '.mov'],
]);

function cleanName(value, fallback = 'content') {
  const name = path.basename(String(value || fallback)).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (name || fallback).slice(0, 255);
}
function parseContentRef(value) {
  const match = /^content:([a-f0-9-]{36})$/.exec(String(value || ''));
  return match ? match[1] : null;
}
function publicAsset(row) {
  return row && {
    id: row.id, accountId: row.account_id, status: row.status, name: row.original_name,
    type: row.mime_type, size: row.size_bytes == null ? null : Number(row.size_bytes),
    sha256: row.sha256, error: row.error, createdAt: row.created_at, updatedAt: row.updated_at,
    ref: `content:${row.id}`, previewUrl: `/api/content/${row.id}`,
    url: `/api/content/${row.id}?download=1`,
  };
}
async function fileHash(filename) {
  const hash = createHash('sha256'); let size = 0;
  for await (const chunk of createReadStream(filename)) { size += chunk.length; hash.update(chunk); }
  return { size, sha256: hash.digest('hex') };
}
async function streamHash(stream) {
  const hash = createHash('sha256'); let size = 0;
  for await (const chunk of stream) { size += chunk.length; hash.update(chunk); }
  return { size, sha256: hash.digest('hex') };
}

async function createContentService({ pool, storage, dataDirectory, fetchImpl = fetch, onChange = () => {}, interval = 1000 }) {
  if (!pool || !storage) return null;
  const stagingDirectory = path.join(dataDirectory, 'content-staging');
  await fs.mkdir(stagingDirectory, { recursive: true });
  const workerFile = path.join(dataDirectory, 'content-worker-id');
  let workerId;
  try { workerId = (await fs.readFile(workerFile, 'utf8')).trim(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    workerId = randomUUID();
    try { await fs.writeFile(workerFile, workerId, { flag: 'wx', mode: 0o600 }); }
    catch (writeError) { if (writeError.code !== 'EEXIST') throw writeError; workerId = (await fs.readFile(workerFile, 'utf8')).trim(); }
  }
  if (!UUID.test(workerId)) throw new Error('Некорректный идентификатор исполнителя контента');
  await pool.query("UPDATE content_jobs SET state='retry',locked_at=NULL,locked_by=NULL,next_attempt_at=now(),updated_at=now() WHERE state='processing' AND locked_by=$1", [workerId]);
  await pool.query("UPDATE content_jobs SET source='{\"type\":\"stored\"}'::jsonb,updated_at=now() WHERE state='done' AND source<>(jsonb_build_object('type','stored'))");

  let timer = null, running = false, closed = false;
  const stagePath = assetId => path.join(stagingDirectory, `${assetId}.stage`);
  const key = (accountId, assetId) => `accounts/${accountId}/content/${assetId}`;
  const schedule = (delay = 0) => {
    if (closed || timer) return;
    timer = setTimeout(() => { timer = null; void tick(); }, delay);
    timer.unref?.();
  };
  async function row(accountId, assetId) {
    if (!UUID.test(String(assetId || ''))) return null;
    return (await pool.query('SELECT * FROM content_assets WHERE account_id=$1 AND id=$2', [accountId, assetId])).rows[0] || null;
  }
  async function insertAsset(accountId, assetId, details, source) {
    const storageKey = details.storageKey || key(accountId, assetId);
    await transaction(pool, async client => {
      await client.query(`INSERT INTO content_assets(account_id,id,storage_key,original_name,mime_type,size_bytes,sha256,status,origin)
        VALUES($1,$2,$3,$4,$5,$6,$7,'saving',$8)`, [accountId, assetId, storageKey, cleanName(details.name), details.type || 'application/octet-stream', details.size ?? null, details.sha256 || null, JSON.stringify(details.origin || {})]);
      await client.query("INSERT INTO content_jobs(id,account_id,asset_id,state,source) VALUES($1,$2,$3,'pending',$4)", [randomUUID(), accountId, assetId, JSON.stringify(source)]);
    });
    schedule();
    return publicAsset(await row(accountId, assetId));
  }
  async function createFromBuffer(accountId, { bytes, name, type, origin = {} }) {
    const body = Buffer.from(bytes || []);
    if (!body.length) throw new Error('Исходный файл пуст');
    if (!TYPES.test(type || '')) throw new Error('Этот тип контента не поддерживается');
    const assetId = randomUUID(), filename = stagePath(assetId);
    await fs.writeFile(filename, body, { flag: 'wx' });
    const sha256 = createHash('sha256').update(body).digest('hex');
    try {
      return await insertAsset(accountId, assetId, { name, type, size: body.length, sha256, origin }, {
        type: 'stage', path: path.relative(dataDirectory, filename).replace(/\\/g, '/'), workerId,
      });
    } catch (error) { await fs.unlink(filename).catch(() => {}); throw error; }
  }
  async function createFromUrl(accountId, { url, name = 'result', origin = {} }) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Для сохранения результата требуется HTTPS-ссылка');
    const assetId = randomUUID();
    return insertAsset(accountId, assetId, { name, type: 'application/octet-stream', origin }, { type: 'url', url: parsed.toString() });
  }
  async function link(accountId, namespace, recordId, assetId, role, position) {
    if (!['source', 'result'].includes(role) || !Number.isInteger(position) || position < 0) throw new Error('Некорректная связь контента');
    await pool.query(`INSERT INTO content_links(account_id,namespace,record_id,asset_id,role,position)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(account_id,namespace,record_id,role,position)
      DO UPDATE SET asset_id=EXCLUDED.asset_id`, [accountId, namespace, recordId, assetId, role, position]);
  }
  async function claim() {
    return transaction(pool, async client => {
      const result = await client.query(`SELECT * FROM content_jobs
        WHERE state IN ('pending','retry') AND next_attempt_at<=now()
          AND ((source->>'type')='url' OR (source->>'workerId')=$1)
        ORDER BY next_attempt_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1`, [workerId]);
      const job = result.rows[0];
      if (!job) return null;
      await client.query("UPDATE content_jobs SET state='processing',attempts=attempts+1,locked_at=now(),locked_by=$2,updated_at=now() WHERE id=$1", [job.id, workerId]);
      return { ...job, attempts: Number(job.attempts) + 1 };
    });
  }
  async function download(job, asset) {
    const filename = stagePath(asset.id), temporary = filename + '.part';
    const response = await fetchImpl(job.source.url, { signal: AbortSignal.timeout(300000) });
    if (!response.ok || !response.body) throw new Error(`Скачивание результата: HTTP ${response.status}`);
    if (response.url && new URL(response.url).protocol !== 'https:') throw new Error('Небезопасное перенаправление результата');
    const type = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
    if (!TYPES.test(type)) throw new Error('Провайдер вернул неподдерживаемый тип контента');
    const hash = createHash('sha256'); let size = 0;
    const meter = new Transform({ transform(chunk, _encoding, callback) { size += chunk.length; hash.update(chunk); callback(null, chunk); } });
    try { await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(temporary, { flags: 'wx' })); await fs.rename(temporary, filename); }
    finally { await fs.unlink(temporary).catch(() => {}); }
    if (!size) throw new Error('Провайдер вернул пустой файл');
    const extension = EXTENSIONS.get(type) || path.extname(new URL(job.source.url).pathname).toLowerCase();
    return { filename, size, sha256: hash.digest('hex'), type, name: asset.original_name === 'result' && extension ? `result${extension}` : asset.original_name };
  }
  async function processJob(job) {
    const asset = await row(job.account_id, job.asset_id);
    if (!asset) return;
    let filename, measured;
    try {
      if (job.source.type === 'url') measured = await download(job, asset);
      else {
        filename = path.resolve(dataDirectory, job.source.path || '');
        const relative = path.relative(stagingDirectory, filename);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Некорректный staging-путь');
        measured = { filename, ...(await fileHash(filename)), type: asset.mime_type, name: asset.original_name };
      }
      filename = measured.filename;
      await storage.put(asset.storage_key, createReadStream(filename), measured.type, measured.size);
      const head = await storage.head(asset.storage_key);
      if (head.size !== measured.size) throw new Error('Размер объекта S3 не совпадает после записи');
      const remote = await storage.stream(asset.storage_key);
      const verified = await streamHash(remote.body);
      if (verified.size !== measured.size || verified.sha256 !== measured.sha256) throw new Error('Контрольная сумма объекта S3 не совпадает');
      await transaction(pool, async client => {
        await client.query(`UPDATE content_assets SET status='ready',original_name=$3,mime_type=$4,size_bytes=$5,sha256=$6,error=NULL,updated_at=now()
          WHERE account_id=$1 AND id=$2`, [job.account_id, job.asset_id, cleanName(measured.name), measured.type, measured.size, measured.sha256]);
        await client.query("UPDATE content_jobs SET state='done',source='{\"type\":\"stored\"}'::jsonb,locked_at=NULL,locked_by=NULL,last_error=NULL,updated_at=now() WHERE id=$1", [job.id]);
      });
      await fs.unlink(filename).catch(() => {});
      onChange(job.account_id, job.asset_id);
    } catch (error) {
      const retry = job.attempts < 5;
      const message = String(error?.message || 'Не удалось сохранить контент').slice(0, 1000);
      await transaction(pool, async client => {
        await client.query("UPDATE content_assets SET status=$3,error=$4,updated_at=now() WHERE account_id=$1 AND id=$2", [job.account_id, job.asset_id, retry ? 'saving' : 'failed', message]);
        await client.query(`UPDATE content_jobs SET state=$2,next_attempt_at=now()+($3::text||' seconds')::interval,
          locked_at=NULL,locked_by=NULL,last_error=$4,updated_at=now() WHERE id=$1`, [job.id, retry ? 'retry' : 'failed', Math.min(60, 2 ** job.attempts), message]);
      });
      onChange(job.account_id, job.asset_id);
    }
  }
  async function tick() {
    if (running || closed) return;
    running = true;
    try { for (let job; (job = await claim());) await processJob(job); }
    finally {
      running = false;
      if (!closed) {
        const pending = Number((await pool.query("SELECT count(*) AS count FROM content_jobs WHERE state IN ('pending','retry')")).rows[0]?.count || 0);
        if (pending) schedule(interval);
      }
    }
  }
  async function wait(accountId, assetId, timeout = 300000) {
    const deadline = Date.now() + timeout;
    schedule();
    while (Date.now() < deadline) {
      const asset = await row(accountId, assetId);
      if (!asset) throw Object.assign(new Error('Файл не найден'), { status: 404 });
      if (asset.status === 'ready') return publicAsset(asset);
      if (['failed', 'missing'].includes(asset.status)) throw new Error(asset.error || 'Файл не сохранён');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('Сохранение файла ещё не завершено');
  }
  async function file(accountId, assetId) {
    const asset = await row(accountId, assetId);
    if (!asset) throw Object.assign(new Error('Файл не найден'), { status: 404 });
    if (asset.status === 'ready') return { storageKey: asset.storage_key, name: asset.original_name, type: asset.mime_type };
    const job = (await pool.query('SELECT source FROM content_jobs WHERE account_id=$1 AND asset_id=$2', [accountId, assetId])).rows[0];
    if (asset.status === 'saving' && job?.source?.type === 'stage' && job.source.workerId === workerId) {
      const filename = path.resolve(dataDirectory, job.source.path || '');
      if (await fs.stat(filename).then(stat => stat.isFile()).catch(() => false)) return { path: filename, name: asset.original_name, type: asset.mime_type };
    }
    throw Object.assign(new Error(asset.error || 'Файл ещё сохраняется'), { status: asset.status === 'saving' ? 409 : 404 });
  }
  async function read(accountId, assetId) {
    const resolved = await file(accountId, assetId);
    return resolved.storageKey ? storage.read(resolved.storageKey) : fs.readFile(resolved.path);
  }
  async function retry(accountId, assetId) {
    await transaction(pool, async client => {
      await client.query("UPDATE content_assets SET status='saving',error=NULL,updated_at=now() WHERE account_id=$1 AND id=$2 AND status IN ('failed','missing')", [accountId, assetId]);
      await client.query("UPDATE content_jobs SET state='retry',attempts=0,next_attempt_at=now(),last_error=NULL,updated_at=now() WHERE account_id=$1 AND asset_id=$2 AND state='failed'", [accountId, assetId]);
    });
    schedule();
  }
  async function register(accountId, details) {
    const existing = (await pool.query('SELECT * FROM content_assets WHERE storage_key=$1', [details.storageKey])).rows[0];
    if (existing) return publicAsset(existing);
    const assetId = details.id || randomUUID();
    await pool.query(`INSERT INTO content_assets(account_id,id,storage_key,original_name,mime_type,size_bytes,sha256,status,origin,error)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [accountId, assetId, details.storageKey, cleanName(details.name), details.type || 'application/octet-stream',
      details.size ?? null, details.sha256 || null, details.status, JSON.stringify(details.origin || {}), details.error || null]);
    return publicAsset(await row(accountId, assetId));
  }
  schedule();
  return {
    workerId, createFromBuffer, createFromUrl, register, link, wait, file, read, retry,
    get: async (accountId, assetId) => publicAsset(await row(accountId, assetId)),
    links: async (accountId, namespace, recordId, role) => (await pool.query(`SELECT l.role,l.position,a.* FROM content_links l
      JOIN content_assets a ON a.account_id=l.account_id AND a.id=l.asset_id
      WHERE l.account_id=$1 AND l.namespace=$2 AND l.record_id=$3 AND ($4::text IS NULL OR l.role=$4)
      ORDER BY l.position`, [accountId, namespace, recordId, role || null])).rows.map(item => ({ ...publicAsset(item), role: item.role, position: item.position })),
    list: async accountId => (await pool.query('SELECT * FROM content_assets WHERE account_id=$1 ORDER BY created_at DESC', [accountId])).rows.map(publicAsset),
    close: async () => { closed = true; if (timer) clearTimeout(timer); while (running) await new Promise(resolve => setTimeout(resolve, 10)); },
  };
}

module.exports = { createContentService, parseContentRef, publicAsset };
