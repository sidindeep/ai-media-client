module.exports = function kieRaw(raw, context) {
  const amountUnits = Number(raw?.amountUnits);
  if (!Number.isSafeInteger(amountUnits) || amountUnits <= 0) {
    throw new Error('Себестоимость Kie не определена');
  }
  return { fixedAmountUnits: amountUnits, rawVersion: raw.version };
};
