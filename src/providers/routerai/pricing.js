function unavailable(message = 'Цена выбранных параметров RouterAI не определена') {
  return Object.assign(new Error(message), { status: 400 });
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function quoteRouterAi(model, request) {
  if (!model || model.id !== request.model) throw unavailable('Тариф модели RouterAI не найден');
  const pricing = model.pricing || {};
  const priceUnits = model.pricing_units || {};
  const payload = request.payload || {};
  let rubles;

  if (request.endpoint === 'videos') {
    const rate = positiveNumber(pricing.seconds);
    if (!rate || priceUnits.seconds !== 'second') throw unavailable();
    const durations = Array.isArray(model.supported_durations) ? model.supported_durations : [];
    const duration = Number(payload.duration ?? durations[0]);
    if (!Number.isSafeInteger(duration) || duration <= 0 || (durations.length && !durations.includes(duration))) {
      throw unavailable('Укажите поддерживаемую длительность видео для расчёта цены');
    }
    const resolutions = Array.isArray(model.supported_resolutions) ? model.supported_resolutions : [];
    if (resolutions.length > 1 && payload.resolution && payload.resolution !== resolutions[0]) {
      throw unavailable('Цена выбранного разрешения видео RouterAI не опубликована в API');
    }
    const supported = new Set(['prompt', 'duration', 'resolution', 'aspect_ratio']);
    if (Object.keys(payload).some(key => !supported.has(key))) throw unavailable('Цена дополнительных параметров видео RouterAI не определена');
    if (Object.entries(pricing).some(([key, value]) => key !== 'seconds' && Number(value) > 0)) throw unavailable();
    rubles = rate * duration;
  } else {
    const nonzero = Object.entries(pricing).filter(([, value]) => Number(value) > 0);
    if (nonzero.length !== 1) throw unavailable('Стоимость этой модели RouterAI зависит от фактического расхода');
    const [key, value] = nonzero[0];
    const unit = priceUnits[key];
    if (unit === 'request') rubles = Number(value);
    else if (unit === 'image' && request.endpoint === 'images') {
      if (Array.isArray(model.image_pricing) && model.image_pricing.some(item => item.variant != null)) throw unavailable();
      if (Object.keys(payload).some(field => !['prompt', 'n'].includes(field))) throw unavailable();
      const count = Number(payload.n ?? 1);
      if (!Number.isSafeInteger(count) || count < 1 || count > 16) throw unavailable();
      rubles = Number(value) * count;
    } else throw unavailable('Стоимость этой модели RouterAI зависит от фактического расхода');
  }
  if (!Number.isFinite(rubles) || rubles <= 0) throw unavailable();
  return { amount: rubles, currency: 'RUB', version: `routerai-live-${model.priceFetchedAt}` };
}

module.exports = { quoteRouterAi };
