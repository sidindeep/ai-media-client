const ESTIMATED_OUTPUT_TOKENS = 512;

function simpleRates(payload) {
  const pricing = payload?.data?.pricing;
  const rates = pricing?.effective_rates;
  if (pricing?.unit !== 'usd_per_million_tokens' || pricing?.tier_count !== 1
    || !rates || Object.keys(rates).some(key => !['input', 'output'].includes(key))
    || !Number.isFinite(rates.input) || !Number.isFinite(rates.output)
    || rates.input < 0 || rates.output < 0) return null;
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
    const resolution = String(selected('resolution', '')).toUpperCase();
    const resolutionPrices = data.resolution_paid_prices;
    const hasResolutionPrices = resolutionPrices && Object.keys(resolutionPrices).length > 0;
    if (data.billing_type === 'tiered_token' && !hasResolutionPrices) return null;
    const perImage = hasResolutionPrices ? resolutionPrices[resolution] : data.paid_price;
    const count = Number(selected('n', options.num_images || 1));
    if (Number.isFinite(perImage) && Number.isInteger(count) && count >= 1 && count <= 12) amountUsd = perImage * count;
  } else if (model.kind === 'video' && data.billing_type === 'per_second') {
    const resolution = String(selected('resolution', '')).toUpperCase();
    const referenceVideo = Array.isArray(options.video_urls) && options.video_urls.length > 0;
    // APIMart bills reference duration plus output duration. URL count alone
    // cannot establish the length, so this request has no reliable estimate.
    if (referenceVideo) return null;
    const resolutionPrices = data.resolution_paid_prices;
    let perSecond = resolutionPrices && Object.keys(resolutionPrices).length
      ? resolutionPrices[resolution] : data.paid_price;
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
    ? { status: 'estimated', credits: null, amountUsd, nativeCredits: amountUsd * 10 } : null;
}

module.exports = { simpleRates, estimate, usedCost, mediaEstimate };
