module.exports = function codexRaw(raw) {
  const amountUnits = Number(raw?.amountUnits);
  if (!Number.isSafeInteger(amountUnits) || amountUnits <= 0) {
    throw new Error('Фиксированная цена Codex не опубликована');
  }
  // Per-request provider expense is not available; retain the published product tariff.
  return { fixedAmountUnits: amountUnits, rawVersion: raw.version };
};
