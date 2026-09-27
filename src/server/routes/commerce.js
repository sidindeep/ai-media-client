async function handleCommerceRequest({ req, url, user, config, commerce, send, readJson }) {
  if (!commerce) return send(503, { error: 'Платёжный модуль пока недоступен', code: 'PAYMENTS_DISABLED' });
  const checkoutMode = config.payments?.provider === 'yookassa-stub' ? 'stub' : 'redirect';
  if (req.method === 'GET' && url.pathname === '/api/commerce/offers')
    return send(200, { result: config.commerce?.salesEnabled ? commerce.offers().map(offer => ({ ...offer, checkoutMode })) : [] });
  if (req.method === 'GET' && url.pathname === '/api/commerce/orders')
    return send(200, { result: (await commerce.listOrders(user.id)).map(order => ({ ...order, checkoutMode })) });
  const orderMatch = /^\/api\/commerce\/orders\/([a-f0-9-]{36})(?:\/(checkout))?$/.exec(url.pathname);
  if (req.method === 'GET' && orderMatch && !orderMatch[2])
    return send(200, { result: { ...await commerce.getOrder(user.id, orderMatch[1]), checkoutMode } });
  if (req.method === 'POST' && url.pathname === '/api/commerce/orders' && req.headers['x-media-client'] === 'web') {
    if (!config.commerce?.salesEnabled) return send(503, { error: 'Продажа кредитов пока недоступна', code: 'SALES_DISABLED' });
    return send(200, { result: await commerce.createOrder(user.id, await readJson(8192)) });
  }
  if (req.method === 'POST' && orderMatch?.[2] === 'checkout' && req.headers['x-media-client'] === 'web') {
    if (!config.commerce?.salesEnabled) return send(503, { error: 'Продажа кредитов пока недоступна', code: 'SALES_DISABLED' });
    const returnUrl = `${config.auth.origin}/app?order=${encodeURIComponent(orderMatch[1])}`;
    return send(200, { result: { ...await commerce.checkout(user.id, orderMatch[1], returnUrl), checkoutMode } });
  }
  return send(404, { error: 'Метод не найден' });
}

module.exports = { handleCommerceRequest };
