const { AccountRecords } = require('../database/records');
const catalog = require('../../config/codex-models.json');

function codexRecord(job) {
  const image = job.state === 'success' && job.hasImage === true;
  const url = `/api/codex/jobs/${encodeURIComponent(job.id)}/image`;
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

async function generationHistory(pool, accountId, service, present = record => record) {
  const [media, codex] = await Promise.all([
    service.listHistory(), new AccountRecords(pool, accountId, 'codex').list()
  ]);
  return [...media.map(present), ...codex.map(codexRecord)]
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || a.id.localeCompare(b.id));
}
async function generationHistorySince(pool, accountId, service, since, before, present = record => record) {
  const [media, codex] = await Promise.all([
    service.listHistorySince(since, before), new AccountRecords(pool, accountId, 'codex').listSince(since, before)
  ]);
  return [...media.map(present), ...codex.map(codexRecord)]
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || a.id.localeCompare(b.id));
}
module.exports = { generationHistory, generationHistorySince };
