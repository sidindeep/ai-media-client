const fs = require('node:fs');

function createProductCatalog(filename) {
  const source = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const offers = new Map();
  for (const raw of source.offers || []) {
    const offer = { id: String(raw.id), version: String(raw.version), name: String(raw.name), description: String(raw.description || ''),
      creditUnits: Number(raw.creditUnits), amountMinor: Number(raw.amountMinor), currency: String(raw.currency || '').toUpperCase(), active: raw.active === true };
    if (!/^[a-z][a-z0-9_-]{2,60}$/.test(offer.id) || !offer.version || !offer.name || !Number.isSafeInteger(offer.creditUnits) || offer.creditUnits <= 0
      || !Number.isSafeInteger(offer.amountMinor) || offer.amountMinor <= 0 || offer.currency !== 'RUB') throw new Error('Некорректный каталог платных предложений');
    const key = `${offer.id}:${offer.version}`; if (offers.has(key)) throw new Error('Предложения должны быть уникальны по id и version'); offers.set(key, offer);
  }
  return {
    list: () => [...offers.values()].filter(item => item.active).map(item => ({ ...item })),
    get(id, version) { const offer = offers.get(`${id}:${version}`); if (!offer?.active) throw Object.assign(new Error('Предложение недоступно'), { code: 'OFFER_UNAVAILABLE', status: 409 }); return { ...offer }; },
  };
}
module.exports = { createProductCatalog };
