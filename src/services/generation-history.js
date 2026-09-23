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
module.exports = { generationHistory, generationHistorySince };
