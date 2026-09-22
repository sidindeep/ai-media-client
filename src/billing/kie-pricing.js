const { units, SCALE } = require('./pricing');
const fallbackConfig = require('../../config/kie-price-fallbacks.json');

function buildFallbackIndex(config) {
  if (config?.schemaVersion !== 1 || !config.version || !config.source || !config.models) {
    throw new Error('Некорректная конфигурация резервных тарифов Kie');
  }
  const index = new Map();
  for (const [modelId, variants] of Object.entries(config.models)) {
    if (!modelId || !Array.isArray(variants) || !variants.length) throw new Error('Некорректная модель резервного тарифа Kie');
    const modelVariants = new Map();
    for (const variant of variants) {
      const resolution = String(variant.resolution || '').trim().toLowerCase();
      const duration = Number(variant.duration);
      const amountUnits = Number(variant.amountUnits);
      if (!resolution || !Number.isSafeInteger(duration) || duration <= 0 || !Number.isSafeInteger(amountUnits) || amountUnits <= 0) {
        throw new Error('Некорректный вариант резервного тарифа Kie');
      }
      const key = `${resolution}:${duration}`;
      if (modelVariants.has(key)) throw new Error('Дублирующийся вариант резервного тарифа Kie');
      modelVariants.set(key, amountUnits);
    }
    index.set(modelId, modelVariants);
  }
  return index;
}

const fallbackIndex = buildFallbackIndex(fallbackConfig);

function modelIdFromAnchor(anchor) {
  try {
    const url = new URL(anchor);
    const queryModel = url.searchParams.get('model');
    if (queryModel) return queryModel;
    return decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, '');
  } catch { return ''; }
}

function pathModelIdFromAnchor(anchor) {
  try {
    const url = new URL(anchor);
    if (url.searchParams.has('model')) return '';
    return decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, '');
  } catch { return ''; }
}

function modelCandidates(model, rows) {
  const aliases = new Set([model.apiModel, model.id?.replace(/^kie:/, '')].filter(Boolean));
  const exact = rows.filter(row => aliases.has(modelIdFromAnchor(row.anchor)));
  if (exact.length) return exact;

  // Some Kie price-list pages omit the provider namespace from their anchor
  // (for example bytedance/seedance-2-5 is published at /seedance-2-5).
  // Only use this suffix fallback when the anchor has no explicit ?model= id;
  // an explicit id remains authoritative and must match exactly.
  const suffixes = new Set([...aliases].map(alias => alias.split('/').pop()).filter(Boolean));
  return rows.filter(row => suffixes.has(pathModelIdFromAnchor(row.anchor)));
}

function normalized(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function containsValue(description, value) {
  const needle = normalized(value);
  return needle.length > 0 && normalized(description).includes(needle);
}

function containsDuration(description, value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return false;
  const literal = String(seconds).replace('.', '\\.');
  return new RegExp(`(?:^|[^0-9.])${literal}(?:\\.0+)?\\s*(?:s|sec|second)(?:$|[^a-z])`, 'i').test(String(description));
}

function containsResolution(description, value) {
  const resolution = String(value).trim().toUpperCase();
  if (['1K', '2K'].includes(resolution) && /(?:^|[^0-9])1\s*\/\s*2\s*K(?:$|[^0-9])/i.test(String(description))) return true;
  const match = resolution.match(/^(\d+(?:\.\d+)?)K$/);
  if (match) return new RegExp(`(?:^|[^0-9.])${match[1]}\\s*K(?:$|[^0-9])`, 'i').test(String(description));
  return containsValue(description, value);
}

function decimalUnits(value) {
  const match = String(value).trim().match(/^(\d+)(?:\.(\d{1,3}))?$/);
  if (!match) throw new Error('Цена Kie имеет неподдерживаемый формат');
  const fraction = (match[2] || '').padEnd(3, '0');
  return units(Number(match[1]) * SCALE + Number(fraction || 0));
}

function hasInput(input, fragment) {
  return Object.entries(input || {}).some(([key, value]) => key.toLowerCase().includes(fragment)
    && (Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== ''));
}

function candidateScore(row, input) {
  const description = String(row.modelDescription || '');
  let score = 0;
  for (const key of ['resolution', 'quality', 'mode', 'duration']) {
    const value = input?.[key] ?? input?.[`output_${key}`];
    const matches = key === 'duration' ? containsDuration(description, value)
      : key === 'resolution' ? containsResolution(description, value)
        : containsValue(description, value);
    if (value !== undefined && value !== null && value !== '' && matches) score += 4;
  }
  const audio = input?.generate_audio ?? input?.sound ?? input?.audio;
  if (typeof audio === 'boolean' && /audio|aiduo|sound/i.test(description)) {
    const without = /(?:without|no)\s*(?:audio|aiduo|sound)/i.test(description);
    score += without === !audio ? 5 : -20;
  }
  if (/with\s+video(?:\s+input)?/i.test(description)) score += hasInput(input, 'video') ? 3 : -10;
  if (/no\s+video|without\s+video/i.test(description)) score += hasInput(input, 'video') ? -10 : 3;
  if (/image[ -]to[ -]image/i.test(description)) score += hasInput(input, 'image') ? 2 : 0;
  if (/text[ -]to[ -]image/i.test(description)) score += hasInput(input, 'image') ? -3 : 2;
  return score;
}

function characterCount(value) {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) return value.reduce((total, item) => total + characterCount(item), 0);
  if (!value || typeof value !== 'object') return 0;
  return Object.entries(value).reduce((total, [key, child]) => total + (/^(?:text|content|prompt|scene|sample_context)$/i.test(key) ? characterCount(child) : typeof child === 'object' ? characterCount(child) : 0), 0);
}

function selectTariff(model, input, rows) {
  const candidates = modelCandidates(model, rows);
  if (!candidates.length) throw new Error('Цена этой модели Kie ещё не опубликована');
  const scored = candidates.map(row => ({ row, score: candidateScore(row, input) })).sort((a, b) => b.score - a.score);
  const best = scored.filter(item => item.score === scored[0].score).map(item => item.row);
  const variants = new Map(best.map(row => [`${row.creditPrice}:${row.creditUnit}`, row]));
  if (variants.size !== 1) throw new Error('Цена выбранных параметров Kie ещё не определена');
  return [...variants.values()][0];
}

function inputReferences(value, result = new Set()) {
  if (typeof value === 'string') result.add(value);
  else if (Array.isArray(value)) value.forEach(item => inputReferences(item, result));
  else if (value && typeof value === 'object') Object.values(value).forEach(item => inputReferences(item, result));
  return result;
}

function referencedVideoDuration(input, context) {
  const references = inputReferences(input);
  const videos = (context?.sourceFiles || []).filter(file => references.has(file.ref) && String(file.type || '').startsWith('video/'));
  if (!videos.length) throw new Error('Для расчёта цены нужна длительность исходного видео');
  let total = 0;
  for (const video of videos) {
    const duration = Number(video.durationSeconds);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Не удалось определить длительность исходного видео');
    total += duration;
  }
  return total;
}

function multiplier(row, input, context) {
  const unit = String(row.creditUnit || '').trim().toLowerCase();
  if (unit === 'per second') {
    const duration = Number(input?.duration);
    if (!Number.isSafeInteger(duration) || duration <= 0) throw new Error('Для расчёта цены нужна длительность в секундах');
    // Kie publishes Seedance reference-video tariffs as Price × (Input +
    // Output), not merely Price × Output. Use server-verified media metadata.
    return duration + (/\bwith video(?:\s+input)?\b/i.test(String(row.modelDescription || '')) && hasInput(input, 'video')
      ? referencedVideoDuration(input, context) : 0);
  }
  if (unit === 'per image') {
    const count = Number(input?.num_images ?? input?.number_of_images ?? input?.output_count ?? input?.image_count ?? 1);
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error('Для расчёта цены нужно количество изображений');
    return count;
  }
  if (unit === 'per 2 images') {
    const count = Number(input?.num_images ?? input?.number_of_images ?? input?.output_count ?? input?.image_count ?? 2);
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error('Для расчёта цены нужно количество изображений');
    return Math.ceil(count / 2);
  }
  if (unit === 'per 1000 characters') {
    const count = characterCount(input?.text ?? input?.dialogue ?? input);
    if (!count) throw new Error('Для расчёта цены нужен текст');
    return Math.ceil(count / 1000);
  }
  if (['', 'per video', 'per vedio', 'per request', 'per generation', 'per upscale'].includes(unit)) return 1;
  throw new Error('Единица тарифа Kie пока не поддерживается');
}

function fallbackQuote(model, input) {
  const modelId = model.apiModel || model.id?.replace(/^kie:/, '');
  const variants = fallbackIndex.get(modelId);
  if (!variants) return null;
  const resolution = String(input?.resolution || input?.output_resolution || '').trim().toLowerCase();
  const duration = Number(input?.duration ?? input?.output_duration);
  if (!resolution || !Number.isSafeInteger(duration) || duration <= 0) {
    throw new Error('Для расчёта резервной цены Kie нужны разрешение и длительность');
  }
  const amountUnits = variants.get(`${resolution}:${duration}`);
  if (!amountUnits) throw new Error('Цена выбранных параметров Kie ещё не определена');
  return {
    amountUnits: units(amountUnits),
    credits: amountUnits / SCALE,
    scale: SCALE,
    currency: 'credits',
    version: fallbackConfig.version,
  };
}

function quoteKie(model, input, tariffData, context = {}) {
  if (!model || model.providerId !== 'kie') throw new Error('Модель Kie не найдена');
  const rows = Array.isArray(tariffData?.rows) ? tariffData.rows : [];
  const candidates = modelCandidates(model, rows);
  if (!candidates.length) {
    const fallback = fallbackQuote(model, input || {});
    if (fallback) return fallback;
    if (!rows.length) throw new Error('Цена Kie временно недоступна');
    throw new Error('Цена этой модели Kie ещё не опубликована');
  }
  const row = selectTariff(model, input || {}, rows);
  const amountUnits = units(Math.ceil(decimalUnits(row.creditPrice) * multiplier(row, input || {}, context)));
  return {
    amountUnits,
    credits: amountUnits / SCALE,
    scale: SCALE,
    currency: 'credits',
    version: `kie-live-${String(tariffData.fetchedAt || '').slice(0, 10) || 'unknown'}`,
  };
}

module.exports = { quoteKie, modelIdFromAnchor, selectTariff, fallbackQuote };
