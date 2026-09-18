// Public prices are independent of provider invoices. Integer minor units only.
const SCALE = 1000;
function units(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Некорректная сумма кредитов');
  return value;
}
function createPricing(config = {}) {
  const version = String(config.version || 'unpublished');
  const prices = config.models || {};
  for (const price of Object.values(prices)) {
    units(price.baseUnits); units(price.perSecondUnits || 0);
  }
  return {
    quote(modelId, input = {}) {
      const price = prices[modelId];
      if (!price) throw new Error('Цена модели ещё не опубликована');
      let duration = 0;
      if (price.perSecondUnits) {
        duration = Number(input.duration);
        if (!Number.isSafeInteger(duration) || duration <= 0) throw new Error('Для расчёта цены нужна длительность в секундах');
      }
      const amountUnits = units(price.baseUnits + duration * (price.perSecondUnits || 0));
      if (!amountUnits) throw new Error('Нулевая цена генерации не разрешена');
      return { amountUnits, credits: amountUnits / SCALE, scale: SCALE, currency: 'credits', version };
    }
  };
}
module.exports = { createPricing, units, SCALE };
