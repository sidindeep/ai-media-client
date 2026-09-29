const ESTIMATED_OUTPUT_TOKENS = 512;

function simpleRates(payload) {
  const pricing = payload?.data?.pricing;
  const rates = pricing?.effective_rates;
  if (pricing?.unit !== 'usd_per_million_tokens' || !Number.isInteger(pricing?.tier_count) || pricing.tier_count < 1
    || !rates || Object.keys(rates).some(key => !['input', 'output', 'cached_input', 'cache_write', 'cache_write_5m', 'cache_write_1h'].includes(key))
    || !Number.isFinite(rates.input) || !Number.isFinite(rates.output)
    || rates.input < 0 || rates.output < 0) return null;
  if (pricing.tier_count > 1 && (!Array.isArray(pricing.tiers) || pricing.tiers.length !== pricing.tier_count
    || !Number.isFinite(pricing.tiers[0]?.up_to_input_tokens)
    || pricing.tiers[0].up_to_input_tokens < 20000)) return null;
  return { input: rates.input, output: rates.output };
}

function cost(rates, inputTokens, outputTokens) {
  const amountUsd = (inputTokens * rates.input + outputTokens * rates.output) / 1_000_000;
  return { amountUsd, nativeCredits: amountUsd * 10 };
}

function estimate(rates, prompt) {
  // APIMart does not expose a tokenizer for every model. UTF-8 bytes / 4 is
  // only a rough input-token estimate; output length is unknown before send.
  const inputTokens = Math.max(1, Math.ceil(Buffer.byteLength(prompt, 'utf8') / 4));
  return { ...cost(rates, inputTokens, ESTIMATED_OUTPUT_TOKENS),
    estimatedInputTokens: inputTokens, estimatedOutputTokens: ESTIMATED_OUTPUT_TOKENS,
    inputUsdPerToken: rates.input / 1_000_000, outputUsdPerToken: rates.output / 1_000_000 };
}

function usedCost(rates, usage) {
  const input = usage?.prompt_tokens ?? usage?.input_tokens;
  const output = usage?.completion_tokens ?? usage?.output_tokens;
  const details = usage?.prompt_tokens_details ?? usage?.input_tokens_details;
  if (!Number.isSafeInteger(input) || input < 0 || !Number.isSafeInteger(output) || output < 0
    || (details && Object.values(details).some(value => typeof value === 'number' && value > 0))) return null;
  return cost(rates, input, output);
}

function mediaEstimate(payload, model, options = {}) {
  const data = payload?.data;
  if (!data || model.kind === 'text') return null;
  const selected = (key, fallback) => options[key] ?? model.fields?.find(field => field.key === key)?.apiDefault ?? fallback;
  let amountUsd = null;
  let warning;
  if (model.id === 'suno') {
    const version = typeof options.version === 'string' ? options.version : 'v6';
    amountUsd = data.action_paid_prices?.[`suno@music-${version}`] ?? null;
    if (options.max_mode === true && Number.isFinite(amountUsd)) amountUsd *= data.max_mode_multiplier || 2;
  } else if (model.id === 'flowmusic') {
    amountUsd = data.action_paid_prices?.['flowmusic@generate'] ?? null;
  } else if (model.id === 'midjourney') {
    const speed = String(selected('speed', 'default'));
    amountUsd = data.action_paid_prices?.imagine?.[speed] ?? null;
    if (options.repeat != null) {
      if (!Number.isInteger(options.repeat) || options.repeat < 2 || options.repeat > 40) return null;
      if (Number.isFinite(amountUsd)) amountUsd *= options.repeat;
    }
  } else if (model.kind === 'image' && data.billing_type !== 'per_second') {
    const requestedResolution = String(selected('resolution', '')).toUpperCase();
    const resolutionField = model.fields?.find(field => field.key === 'resolution');
    const resolution = resolutionField?.pricingAliases?.[requestedResolution] || requestedResolution;
    const layers = selected('layer_decomposition', false) === true;
    const resolutionPrices = layers ? data.layer_decomposition_paid_prices : data.resolution_paid_prices;
    const hasResolutionPrices = resolutionPrices && Object.keys(resolutionPrices).length > 0;
    // A provider-published image estimate is independent of the model ID.
    // Token rates alone cannot establish the number of output image tokens.
    const imageEstimate = data.billing_type === 'tiered_token'
      && data.pricing?.unit === 'usd_per_million_tokens'
      && data.pricing?.pricing_mode === 'image_modalities';
    if (data.billing_type === 'tiered_token' && !hasResolutionPrices && !imageEstimate) return null;
    const size = String(selected('size', 'auto')).toUpperCase();
    const layerTier = size === 'AUTO' ? '2K' : size === '1.5K' ? '1K' : size;
    if (layers && (!hasResolutionPrices || !Number.isSafeInteger(data.layer_decomposition_max_images)
      || data.layer_decomposition_max_images <= 0 || (options.image_urls?.length ?? 0) !== 1)) return null;
    // Some providers publish only the 4K surcharge; paid_price is the base
    // 1K/2K estimate. An omitted resolution uses the provider's base estimate.
    const baseTier = !resolution || (['1K', '2K'].includes(resolution)
      && Object.keys(resolutionPrices || {}).every(key => key === '4K'));
    let perImage = hasResolutionPrices ? resolutionPrices[layers ? layerTier : resolution]
      ?? (!layers && baseTier ? data.paid_price : null)
      : data.paid_price;
    if (!layers && hasResolutionPrices && Object.keys(resolutionPrices).some(key => key.includes(':'))) {
      const tierSuffix = !resolution || resolution === '1K' ? '' : `@${resolution.toLowerCase()}`;
      const quality = String(selected('quality', 'auto')).toLowerCase();
      const priceAt = key => data.size_quality_paid_prices
        ? data.size_quality_paid_prices[key]?.[quality] : resolutionPrices[key];
      if (size === 'AUTO') {
        const prices = Object.keys(resolutionPrices).filter(key => (key.split('@')[1] || '') === tierSuffix.slice(1))
          .map(priceAt).filter(value => Number.isFinite(value) && value > 0);
        perImage = prices.length ? Math.max(...prices) : null;
        warning = 'Оценка по максимальной цене автоматического формата; после выполнения спишется фактическая стоимость.';
      } else perImage = priceAt(`${size}${tierSuffix}`);
    }
    const count = Number(selected('n', options.num_images ?? 1));
    if (Number.isFinite(perImage) && Number.isInteger(count) && count >= 1 && count <= 12) {
      if (layers && count !== 1) return null;
      amountUsd = perImage * (layers ? data.layer_decomposition_max_images : count);
      if (layers) warning = `Резерв до ${data.layer_decomposition_max_images} изображений; после выполнения спишется фактическая стоимость.`;
      else if (Number.isFinite(data.input_image_paid_price)) {
        const inputs = Array.isArray(options.image_urls) ? options.image_urls.length : 0;
        const tierPrices = Object.values(data.input_image_paid_prices || {}).filter(price => Number.isFinite(price));
        const inputPrice = tierPrices.length ? Math.max(...tierPrices) : data.input_image_paid_price;
        amountUsd += Math.max(0, inputs - (data.input_image_first_free === true ? 1 : 0)) * inputPrice;
        if (inputs && tierPrices.length) warning = 'Оценка входных изображений по максимальному тарифу: размер исходника пока неизвестен.';
      }
    }
  } else if (model.kind === 'video' && data.billing_type === 'per_second') {
    const resolution = String(selected('resolution', '')).toUpperCase();
    const referenceVideo = Array.isArray(options.video_urls) && options.video_urls.length > 0;
    // APIMart bills reference duration plus output duration. URL count alone
    // cannot establish the length, so this request has no reliable estimate.
    if (referenceVideo) return null;
    const resolutionPrices = data.resolution_paid_prices;
    const defaultResolution = String(data.default_resolution
      ?? model.fields?.find(field => field.key === 'resolution')?.apiDefault ?? '').toUpperCase();
    let perSecond = resolutionPrices && Object.keys(resolutionPrices).length
      ? resolutionPrices[resolution] ?? (resolution === defaultResolution ? data.paid_price : null) : data.paid_price;
    const tierPrices = data.billing_tier_paid_prices;
    if (tierPrices && Object.keys(tierPrices).some(key => !/^token(?:-|$)/i.test(key))) {
      const mode = String(selected('mode', 'std'));
      const sound = selected('audio', false) === true || selected('generate_audio', false) === true;
      const tier = [mode === 'std' ? '' : mode, sound ? 'sound' : ''].filter(Boolean).join('-');
      if (tier) perSecond = tierPrices[tier];
    }
    const duration = Number(selected('duration', NaN));
    if (Number.isFinite(perSecond) && Number.isFinite(duration) && duration > 0 && duration <= 60) amountUsd = perSecond * duration;
  } else if (model.kind === 'video' && Number.isFinite(data.paid_price)) {
    const resolution = String(selected('resolution', '')).toUpperCase();
    amountUsd = data.resolution_paid_prices?.[resolution] ?? data.paid_price;
  }
  return Number.isFinite(amountUsd) && amountUsd >= 0
    ? { status: 'estimated', credits: null, amountUsd, nativeCredits: amountUsd * 10, ...(warning ? { warning } : {}) } : null;
}

function unavailableMediaReason(payload, model, options = {}) {
  const data = payload?.data || {};
  if (options.layer_decomposition === true)
    return 'Нет тарифа разделения на слои для выбранного размера или нужен ровно один исходник';
  if (data.billing_type === 'per_second') {
    if (options.video_urls?.length) return 'Для цены нужна подтверждённая длительность исходного видео';
    const duration = options.duration ?? model.fields?.find(field => field.key === 'duration')?.apiDefault;
    if (!(Number(duration) > 0)) return 'Укажите длительность видео для расчёта цены';
  }
  if (data.resolution_paid_prices && Object.keys(data.resolution_paid_prices).length)
    return 'Провайдер не опубликовал цену выбранного сочетания размера, качества и режима';
  if (data.pricing?.unit === 'usd_per_million_tokens')
    return 'Провайдер вернул токеновый тариф без предварительной цены этого медиа';
  return 'Провайдер не вернул поддерживаемый тариф для этой модели';
}

module.exports = { simpleRates, estimate, usedCost, mediaEstimate, unavailableMediaReason };
