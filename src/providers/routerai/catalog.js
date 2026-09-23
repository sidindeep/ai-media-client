const published = require('../../../config/routerai-models.json');

const URL = 'https://routerai.ru/api/v1/models';
const TTL_MS = 10 * 60 * 1000;

function normalizeModel(raw) {
  if (!raw || typeof raw.id !== 'string' || !/^~?[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:/-]*$/i.test(raw.id)) return null;
  const output = raw.architecture?.output_modalities;
  if (!Array.isArray(output)) return null;
  const kind = output.includes('image') ? 'image' : output.includes('video') ? 'video'
    : output.includes('speech') || output.includes('audio') ? 'audio'
    : output.includes('transcription') ? 'transcription' : output.includes('embeddings') ? 'embeddings'
    : output.includes('rerank') ? 'rerank' : output.includes('decisions') ? 'decisions'
    : output.includes('text') ? 'text' : null;
  if (!kind) return null;
  return {
    id: raw.id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 160) : raw.id,
    description: typeof raw.description === 'string' ? raw.description.trim().slice(0, 180) : '',
    kind,
    endpoint: kind === 'image' && output.includes('text') ? 'chat/completions' : kind === 'image' ? 'images'
      : kind === 'video' ? 'videos' : kind === 'transcription' ? 'audio/transcriptions'
      : kind === 'audio' && output.includes('text') ? 'chat/completions' : kind === 'audio' ? 'audio/speech'
      : kind === 'text' ? 'chat/completions' : kind,
    outputFormat: kind === 'image' && raw.supported_output_formats?.includes('svg') && !raw.supported_output_formats?.some(format => ['png', 'jpeg', 'webp'].includes(format)) ? 'svg' : 'raster',
    ...(kind === 'video' ? { supportedDurations: Array.isArray(raw.supported_durations) ? raw.supported_durations : [],
      supportedResolutions: Array.isArray(raw.supported_resolutions) ? raw.supported_resolutions : [],
      supportedAspectRatios: Array.isArray(raw.supported_aspect_ratios) ? raw.supported_aspect_ratios : [] } : {}),
  };
}

function createRouterAiCatalog({ fetchImpl = fetch, now = Date.now } = {}) {
  let cache = null;
  let tariffs = null;
  let expiresAt = 0;
  let pending = null;
  async function adminModels(force = false) {
    if (!force && cache && now() < expiresAt) return cache;
    if (!pending) pending = (async () => {
      const response = await fetchImpl(URL, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('Каталог RouterAI временно недоступен');
      const payload = await response.json();
      if (!Array.isArray(payload?.data)) throw new Error('Каталог RouterAI вернул неверный ответ');
      const fetchedAt = new Date(now()).toISOString();
      tariffs = new Map(payload.data.filter(item => typeof item?.id === 'string')
        .map(item => [item.id, { ...item, priceFetchedAt: fetchedAt }]));
      const models = payload.data.map(normalizeModel).filter(Boolean);
      if (!models.length) throw new Error('Каталог RouterAI пуст');
      const seen = new Set(models.map(model => model.id));
      cache = [
        ...published.models.map(model => models.find(item => item.id === model.id) || model),
        ...models.filter(model => !published.models.some(item => item.id === model.id)),
      ].filter(model => { if (!seen.has(model.id)) return false; seen.delete(model.id); return true; });
      expiresAt = now() + TTL_MS;
      return cache;
    })().finally(() => { pending = null; });
    return pending;
  }
  return {
    async list(role) { return { models: role === 'admin' ? await adminModels() : published.models }; },
    async all(role) {
      if (role !== 'admin') throw Object.assign(new Error('Доступ запрещён'), { status: 403 });
      return { models: await adminModels() };
    },
    async tariff(modelId, force = false) {
      await adminModels(force);
      return tariffs.get(modelId) || null;
    },
  };
}

module.exports = { createRouterAiCatalog, normalizeModel };
