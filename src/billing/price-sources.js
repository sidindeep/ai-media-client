// A quote is usable only when a source can prove a positive amount for the
// exact request. Missing or failed sources never turn into a zero price.
async function resolvePriceSources(sources, validate = quote => quote) {
  const attempts = [];
  for (const source of sources) {
    if (typeof source.quote !== 'function') continue;
    try {
      const quote = await source.quote();
      if (quote == null) { attempts.push({ source: source.id, status: 'unavailable' }); continue; }
      const amount = quote.amountUnits ?? quote.amount;
      if (!Number.isFinite(amount) || amount <= 0 || !quote.version) {
        throw new Error('Источник вернул неподтверждённую цену');
      }
      const value = validate(quote);
      return { source: source.id, quote, value, attempts };
    } catch (error) {
      attempts.push({ source: source.id, status: 'unavailable', error });
    }
  }
  return { source: null, quote: null, attempts };
}

module.exports = { resolvePriceSources };
