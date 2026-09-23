const fs = require('node:fs');
const { SCALE, units } = require('../pricing');
const kieRaw = require('./adapters/kie');
const routerAiRaw = require('./adapters/routerai');
const codexRaw = require('./adapters/codex');
const defaultPolicy = require('../../../config/credit-conversion.json');
const defaultOffers = require('../../../config/product-offers.json').offers;

const adapters = Object.freeze({ kie: kieRaw, routerai: routerAiRaw, codex: codexRaw });

function createCreditConversion({ offersFile, kieRubPerCredit, policy = defaultPolicy, offers,
  providerAdapters = {}, fxRates = {}, now = () => Date.now() } = {}) {
  const availableOffers = offers || (offersFile ? JSON.parse(fs.readFileSync(offersFile, 'utf8')).offers : defaultOffers);
  const active = availableOffers.filter(offer => offer.active);
  if (!active.length || !policy?.version) throw new Error('Политика конвертации кредитов не опубликована');
  const fractions = [policy.deductionsFraction, policy.costMarkupFraction];
  if (fractions.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    || policy.deductionsFraction >= 1) throw new Error('Некорректная политика конвертации кредитов');
  const rubPerCredit = Math.min(...active.map(offer => {
    const amount = Number(offer.amountMinor), credits = Number(offer.creditUnits);
    if (!Number.isSafeInteger(amount) || amount <= 0 || !Number.isSafeInteger(credits) || credits <= 0) {
      throw new Error('Некорректный пакет кредитов');
    }
    if (offer.currency !== 'RUB') throw new Error('Для расчёта нужна рублёвая цена пакета кредитов');
    return amount * 10 / credits;
  }));
  const netRubPerCredit = rubPerCredit * (1 - policy.deductionsFraction);
  if (!(netRubPerCredit > 0)) throw new Error('Некорректная выручка за кредит');

  function quote(providerId, raw) {
    const adapter = providerAdapters[providerId] || adapters[providerId];
    if (!adapter) throw new Error(`Конвертер ${providerId} не подключён`);
    const result = adapter(raw, { kieRubPerCredit });
    let costRub, fxVersion = 'rub';
    if (result.fixedAmountUnits === undefined) {
      const costAmount = Number(result.costAmount);
      if (!Number.isFinite(costAmount) || costAmount <= 0) throw new Error('Себестоимость роутера не определена');
      if (result.costCurrency === 'RUB') costRub = costAmount;
      else {
        const rate = fxRates[result.costCurrency];
        if (!rate || !Number.isFinite(rate.rubPerUnit) || rate.rubPerUnit <= 0
          || !rate.version || !Number.isFinite(Date.parse(rate.validUntil)) || Date.parse(rate.validUntil) <= now()) {
          throw new Error('Курс валюты роутера отсутствует или устарел');
        }
        costRub = costAmount * rate.rubPerUnit;
        fxVersion = rate.version;
      }
    }
    const nominalCredits = result.nominalCredits === undefined ? 0 : Number(result.nominalCredits);
    if (!Number.isFinite(nominalCredits) || nominalCredits < 0) throw new Error('Некорректная номинальная цена роутера');
    const amountUnits = result.fixedAmountUnits === undefined
      ? units(Math.max(
        Math.ceil((costRub * (1 + policy.costMarkupFraction) / netRubPerCredit) * SCALE - 1e-9),
        Math.ceil(nominalCredits * SCALE - 1e-9)))
      : units(result.fixedAmountUnits);
    if (!amountUnits) throw new Error('Нулевая цена генерации не разрешена');
    return { amountUnits, credits: amountUnits / SCALE, scale: SCALE, currency: 'credits',
      version: `${providerId}:${String(result.rawVersion || 'unknown')}:${fxVersion}:${policy.version}` };
  }
  return { quote };
}

module.exports = { createCreditConversion };
