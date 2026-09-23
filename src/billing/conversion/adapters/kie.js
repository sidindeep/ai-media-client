module.exports = function kieRaw(raw, context) {
  const amount = Number(raw?.amountUnits) / 1000;
  const rate = Number(context.kieRubPerCredit);
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(rate) || rate <= 0) {
    throw new Error('Себестоимость Kie не определена');
  }
  return { costAmount: amount * rate, costCurrency: 'RUB', nominalCredits: amount, rawVersion: raw.version };
};
