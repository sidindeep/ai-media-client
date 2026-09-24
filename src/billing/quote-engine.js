// Provider-neutral tariff arithmetic. A strategy only receives a verified rate
// and the quantity that the same request will send to the provider.
function positive(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(label);
  return number;
}

function count(value, label) {
  const number = positive(value, label);
  if (!Number.isSafeInteger(number)) throw new Error(label);
  return number;
}

const strategies = Object.freeze({
  request: () => 1,
  image: ({ quantity }) => count(quantity, 'Для расчёта цены нужно количество изображений'),
  imageBundle: ({ quantity, bundleSize }) => Math.ceil(count(quantity, 'Для расчёта цены нужно количество изображений')
    / count(bundleSize, 'Некорректный размер пакета изображений')),
  second: ({ quantity }) => positive(quantity, 'Для расчёта цены нужна длительность в секундах'),
  characterBundle: ({ quantity, bundleSize }) => Math.ceil(count(quantity, 'Для расчёта цены нужен текст')
    / count(bundleSize, 'Некорректный размер блока символов')),
  token: ({ quantity, bundleSize = 1 }) => positive(quantity, 'Для расчёта цены нужен фактический расход токенов')
    / count(bundleSize, 'Некорректный размер блока токенов'),
});

function calculate({ strategy, rate, quantity, bundleSize = 1 }) {
  const multiplier = strategies[strategy];
  if (!multiplier) throw new Error('Единица тарифа пока не поддерживается');
  return positive(rate, 'Цена тарифа не определена') * multiplier({ quantity, bundleSize });
}

function quoteResult(status, details = {}) {
  if (!['exact', 'bounded', 'unavailable'].includes(status)) throw new Error('Некорректный статус расчёта');
  return Object.freeze({ status, ...details });
}

function evaluateQuote(compute, classify = () => 'unavailable') {
  try { return quoteResult('exact', { quote: compute() }); }
  catch (error) { return quoteResult('unavailable', { reason: classify(error), error }); }
}

function unpricedQuote(reason = 'price_unavailable') {
  return quoteResult('unavailable', { reason, amountUnits: null, credits: null, currency: 'credits',
    warning: 'Цена сейчас неизвестна. Генерация доступна без предварительного списания кредитов.' });
}

module.exports = { calculate, quoteResult, evaluateQuote, unpricedQuote };
