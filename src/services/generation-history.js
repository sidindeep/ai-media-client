const { AccountRecords } = require('../database/records');
const catalog = require('../../config/codex-models.json');
const routerAiCatalog = require('../../config/routerai-models.json');

function codexRecord(job) {
  const image = job.state === 'success' && job.hasImage === true;
  const url = job.contentAssetId ? `/api/content/${job.contentAssetId}` : `/api/codex/jobs/${encodeURIComponent(job.id)}/image`;
  return {
    id: `codex:${job.id}`, providerId: 'codex', providerName: 'Codex CLI',
    modelId: job.model, model: job.model,
    modelName: catalog.models.find(model => model.id === job.model)?.name || job.model,
    kind: job.kind || 'text', state: job.state === 'running' ? 'generating' : job.state,
    workspace: -1, queueHidden: true,
    requestId: job.id, revision: job.revision,
    createdAt: job.createdAt, updatedAt: job.updatedAt,
    generationStartedAt: job.startedAt || job.createdAt,
    generationCompletedAt: job.completedAt,
    generationDurationMs: job.durationMs,
    input: { prompt: job.prompt, effort: job.effort, speed: job.speed },
    projectId: job.projectId || null, chatId: job.chatId || null,
    output: job.output, usage: job.usage, nativeQuote: job.nativeQuote,
    error: job.error, resultJson: JSON.stringify({ resultUrls: image ? [url] : [] }),
    localFiles: image ? [{ previewUrl: url, url: url + '?download=1', exists: true, name: job.id + '.png' }] : []
  };
}

function routerAiRecord(job) {
  const hasFile = job.state === 'success' && Boolean(job.contentAssetId);
  const image = hasFile && (job.hasImage === true || job.resultType?.startsWith('image/'));
  const preview = image && job.imageType !== 'image/svg+xml' && job.resultType !== 'image/svg+xml';
  const url = job.contentAssetId ? `/api/content/${job.contentAssetId}` : `/api/routerai/jobs/${encodeURIComponent(job.id)}/image`;
  return {
    id: `routerai:${job.id}`, providerId: 'routerai', providerName: 'RouterAI',
    modelId: job.model, model: job.model,
    modelName: routerAiCatalog.models.find(model => model.id === job.model)?.name || job.model,
    kind: job.kind === 'api' ? (job.modelKind === 'video' ? 'video' : job.modelKind === 'audio' ? 'audio' : 'text') : job.kind,
    state: job.state === 'running' ? 'generating' : job.state,
    workspace: -1, queueHidden: true, requestId: job.id, revision: job.revision,
    createdAt: job.createdAt, updatedAt: job.updatedAt,
    generationStartedAt: job.createdAt, generationCompletedAt: job.completedAt, generationDurationMs: job.durationMs,
    input: { prompt: job.prompt }, projectId: job.projectId || null, chatId: job.chatId || null,
    output: job.output, usage: job.usage, nativeQuote: job.nativeQuote, error: job.error, providerVideoId: job.providerVideoId,
    resultJson: JSON.stringify({ resultUrls: hasFile ? [url] : [] }),
    localFiles: hasFile ? [{ ...(preview ? { previewUrl: url } : {}), url: url + '?download=1', exists: true,
      name: job.id + (job.imageType === 'image/svg+xml' ? '.svg' : job.resultType === 'audio/wav' ? '.wav' : job.resultType?.startsWith('audio/') ? '.mp3'
        : job.resultType?.startsWith('video/') ? '.mp4' : '.png') }] : []
  };
}

async function generationHistory(pool, accountId, service, present = record => record) {
  const [media, codex, routerAi] = await Promise.all([
    service.listHistory(), new AccountRecords(pool, accountId, 'codex').list(), new AccountRecords(pool, accountId, 'routerai').list()
  ]);
  return [...media.map(present), ...codex.map(codexRecord), ...routerAi.map(routerAiRecord)]
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || a.id.localeCompare(b.id));
}
async function generationHistorySince(pool, accountId, service, since, before, present = record => record, activeIds = []) {
  const [media, codex, routerAi] = await Promise.all([
    service.listHistorySince(since, before, activeIds), new AccountRecords(pool, accountId, 'codex').listSince(since, before), new AccountRecords(pool, accountId, 'routerai').listSince(since, before)
  ]);
  return [...media.map(present), ...codex.map(codexRecord), ...routerAi.map(routerAiRecord)]
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || a.id.localeCompare(b.id));
}
const activeStates = ['queued', 'preparing', 'submitting', 'waiting', 'queuing', 'generating', 'running'];
function decodeCursor(value) {
  if (!value) return null;
  try {
    if (typeof value !== 'string' || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(cursor) || cursor.length !== 3 || typeof cursor[0] !== 'string'
      || !['history', 'codex', 'routerai'].includes(cursor[1]) || typeof cursor[2] !== 'string'
      || cursor[0].length > 40 || cursor[2].length > 200) throw new Error();
    return cursor;
  } catch { throw Object.assign(new Error('Некорректный курсор истории'), { status: 400 }); }
}
function encodeCursor(row) { return Buffer.from(JSON.stringify([row.created, row.namespace, row.id])).toString('base64url'); }
async function generationHistoryPage(pool, accountId, service, cursorValue, present = record => record, limit = 50) {
  const cursor = decodeCursor(cursorValue);
  const rows = (await pool.query(`SELECT namespace,id,data,COALESCE(data->>'createdAt','') AS created FROM media_records
    WHERE account_id=$1 AND namespace IN ('history','codex','routerai')
      AND COALESCE(data->>'state','')<>ALL($2::text[])
      AND ($3::text IS NULL OR (COALESCE(data->>'createdAt',''),namespace,id)<($3::text,$4::text,$5::text))
    ORDER BY COALESCE(data->>'createdAt','') DESC,namespace DESC,id DESC LIMIT $6`,
  [accountId, activeStates, cursor?.[0] ?? null, cursor?.[1] ?? null, cursor?.[2] ?? null, limit + 1])).rows;
  const page = rows.slice(0, limit);
  const media = page.filter(row => row.namespace === 'history').map(row => row.data);
  const presentedMedia = service.presentHistory ? await service.presentHistory(media) : media;
  const mediaById = new Map(presentedMedia.map(row => [row.id, present(row)]));
  const records = page.map(row => row.namespace === 'history' ? mediaById.get(row.id)
    : row.namespace === 'codex' ? codexRecord(row.data) : routerAiRecord(row.data));
  return { records, next: rows.length > limit ? encodeCursor(page[page.length - 1]) : null };
}
async function generationActive(pool, accountId, service, present = record => record) {
  const rows = (await pool.query(`SELECT namespace,data FROM media_records WHERE account_id=$1
    AND namespace IN ('history','codex','routerai') AND data->>'state'=ANY($2::text[])`, [accountId, activeStates])).rows;
  const media = rows.filter(row => row.namespace === 'history').map(row => row.data);
  const presentedMedia = service.presentHistory ? await service.presentHistory(media) : media;
  const mediaById = new Map(presentedMedia.map(row => [row.id, present(row)]));
  return rows.map(row => row.namespace === 'history' ? mediaById.get(row.data.id)
    : row.namespace === 'codex' ? codexRecord(row.data) : routerAiRecord(row.data));
}
module.exports = { generationHistory, generationHistorySince, generationHistoryPage, generationActive };
