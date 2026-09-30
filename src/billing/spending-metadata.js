const { kieUsdPerCredit } = require('../../config/cost-routing.json');

function nonnegative(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function spendingMetadata(record = {}, namespace = 'history') {
  const provider = namespace === 'history' ? 'kie' : namespace;
  const model = record.model || record.modelId || null;
  const route = { provider, model, account: provider === 'kie' ? record.kieAccountId || 'primary' : null };
  let costUsd = null;
  if (provider === 'kie') {
    const credits = nonnegative(record.creditsConsumed);
    const rate = nonnegative(record.providerUsdPerCredit) ?? kieUsdPerCredit;
    if (credits !== null && rate > 0) costUsd = credits * rate;
  } else if (provider === 'apimart' && record.apimartTariffCost?.confirmed === true) {
    costUsd = nonnegative(record.apimartTariffCost.amountUsd);
  }
  return { costUsd, route };
}

module.exports = { spendingMetadata };
