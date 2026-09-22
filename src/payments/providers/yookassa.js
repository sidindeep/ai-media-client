const { paymentError } = require('../contracts');

function amountValue(minor) { return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`; }
function parseAmount(value) {
  const match = /^(0|[1-9]\d*)\.(\d{2})$/.exec(String(value || ''));
  if (!match) throw paymentError('PROVIDER_UNAVAILABLE', 'ЮKassa вернула некорректную сумму', 502);
  const minor = Number(match[1]) * 100 + Number(match[2]);
  if (!Number.isSafeInteger(minor)) throw paymentError('PROVIDER_UNAVAILABLE', 'Сумма ЮKassa слишком велика', 502);
  return minor;
}
function mapPayment(value, expectedTest) {
  if (!value || typeof value !== 'object' || Boolean(value.test) !== expectedTest) throw paymentError('PROVIDER_UNAVAILABLE', 'ЮKassa вернула платеж из другой среды', 502);
  const statuses = { pending: 'pending', waiting_for_capture: 'pending', succeeded: 'succeeded', canceled: 'canceled' };
  return { providerPaymentId: value.id, status: statuses[value.status] || 'pending', resolution: 'known',
    confirmationUrl: value.confirmation?.confirmation_url || null, expiresAt: value.expires_at || null,
    amountMinor: parseAmount(value.amount?.value), currency: value.amount?.currency, test: Boolean(value.test), raw: value };
}

function createYooKassaProvider({ shopId, secretKey, environment = 'test', fetcher = fetch, apiUrl = 'https://api.yookassa.ru/v3' }) {
  if (!shopId || !secretKey) throw new Error('Для ЮKassa нужны shopId и secretKey');
  const authorization = `Basic ${Buffer.from(`${shopId}:${secretKey}`).toString('base64')}`;
  const call = async (path, options = {}) => {
    let response;
    try { response = await fetcher(apiUrl + path, { ...options, headers: { Authorization: authorization, 'Content-Type': 'application/json', ...(options.headers || {}) }, signal: options.signal || AbortSignal.timeout(15000) }); }
    catch (error) { throw Object.assign(new Error('ЮKassa временно недоступна'), { code: 'PROVIDER_UNAVAILABLE', status: 502, outcome: 'unknown', cause: error }); }
    const body = await response.json().catch(() => null);
    if (!response.ok) throw Object.assign(new Error('ЮKassa отклонила запрос'), { code: 'PROVIDER_UNAVAILABLE', status: 502, outcome: response.status >= 500 ? 'unknown' : 'not_sent', providerStatus: response.status });
    return body;
  };
  return {
    id: 'yookassa', accountId: String(shopId), environment,
    capabilities: () => ({ paymentMethods: ['bank_card', 'yoo_money'], refunds: true, partialRefunds: true }),
    async createPayment(request) {
      const body = { amount: { value: amountValue(request.amountMinor), currency: request.currency }, capture: true,
        confirmation: { type: 'redirect', return_url: request.returnUrl }, description: request.description,
        metadata: { client_id: request.clientId, external_order_id: request.externalOrderId } };
      if (request.paymentMethod) body.payment_method_data = { type: request.paymentMethod };
      if (request.receipt) body.receipt = request.receipt;
      return mapPayment(await call('/payments', { method: 'POST', headers: { 'Idempotence-Key': request.idempotencyKey }, body: JSON.stringify(body) }), environment === 'test');
    },
    async getPayment(providerPaymentId) { return mapPayment(await call(`/payments/${encodeURIComponent(providerPaymentId)}`), environment === 'test'); },
    async verifyWebhook(body) {
      const providerPaymentId = body?.object?.id;
      if (!providerPaymentId) throw paymentError('INVALID_REQUEST', 'Некорректное уведомление ЮKassa');
      return this.getPayment(providerPaymentId);
    },
  };
}
module.exports = { createYooKassaProvider, amountValue, parseAmount };
