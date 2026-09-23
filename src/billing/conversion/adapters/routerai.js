module.exports = function routerAiRaw(raw) {
  const costRub = Number(raw?.amount);
  if (raw?.currency !== 'RUB' || !Number.isFinite(costRub) || costRub <= 0) {
    throw new Error('Рублёвая себестоимость RouterAI не определена');
  }
  return { costAmount: costRub, costCurrency: 'RUB', nominalCredits: costRub, rawVersion: raw.version };
};
