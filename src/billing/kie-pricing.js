const { units, SCALE } = require('./pricing');

function modelIdFromAnchor(anchor) {
  try {
    const url = new URL(anchor);
    const queryModel = url.searchParams.get('model');
    if (queryModel) return queryModel;
    return decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, '');
  } catch { return ''; }
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

function selectTariff(model, input, rows) {
  const aliases = new Set([model.apiModel, model.id?.replace(/^kie:/, '')].filter(Boolean));
  const candidates = rows.filter(row => aliases.has(modelIdFromAnchor(row.anchor)));
  if (!candidates.length) throw new Error('Цена этой модели Kie ещё не опубликована');
  const scored = candidates.map(row => ({ row, score: candidateScore(row, input) })).sort((a, b) => b.score - a.score);
  const best = scored.filter(item => item.score === scored[0].score).map(item => item.row);
  const variants = new Map(best.map(row => [`${row.creditPrice}:${row.creditUnit}`, row]));
  if (variants.size !== 1) throw new Error('Цена выбранных параметров Kie ещё не определена');
  return [...variants.values()][0];
}

function multiplier(row, input) {
  const unit = String(row.creditUnit || '').trim().toLowerCase();
  if (unit === 'per second') {
    const duration = Number(input?.duration);
    if (!Number.isSafeInteger(duration) || duration <= 0) throw new Error('Для расчёта цены нужна длительность в секундах');
    return duration;
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
  if (['', 'per video', 'per vedio', 'per request', 'per generation', 'per upscale'].includes(unit)) return 1;
  throw new Error('Единица тарифа Kie пока не поддерживается');
}

function quoteKie(model, input, tariffData) {
  if (!model || model.providerId !== 'kie') throw new Error('Модель Kie не найдена');
  if (!Array.isArray(tariffData?.rows) || !tariffData.rows.length) throw new Error('Цена Kie временно недоступна');
  const row = selectTariff(model, input || {}, tariffData.rows);
  const amountUnits = units(decimalUnits(row.creditPrice) * multiplier(row, input || {}));
  return {
    amountUnits,
    credits: amountUnits / SCALE,
    scale: SCALE,
    currency: 'credits',
    version: `kie-live-${String(tariffData.fetchedAt || '').slice(0, 10) || 'unknown'}`,
  };
}

module.exports = { quoteKie, modelIdFromAnchor, selectTariff };
