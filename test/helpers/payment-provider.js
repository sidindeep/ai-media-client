function createFakePaymentProvider({ behavior = 'success' } = {}) {
  const payments = new Map();
  return {
    id: 'fake', accountId: 'isolated-tests', environment: 'test',
    capabilities: () => ({ paymentMethods: ['bank_card'], refunds: true, partialRefunds: true }),
    async createPayment(request) {
      const existing = payments.get(request.idempotencyKey);
      if (existing) return existing;
      if (behavior === 'timeout-before-send') throw Object.assign(new Error('Test timeout'), { outcome: 'not_sent' });
      const id = `fake-${request.idempotencyKey}`;
      const result = { providerPaymentId: id, status: behavior === 'pending' ? 'pending' : 'succeeded',
        resolution: behavior === 'unknown' ? 'unknown' : 'known', confirmationUrl: behavior === 'pending' ? `https://example.test/pay/${id}` : null,
        amountMinor: request.amountMinor, currency: request.currency, test: true };
      payments.set(request.idempotencyKey, result);
      if (behavior === 'timeout-after-accept') throw Object.assign(new Error('Test response lost'), { outcome: 'unknown' });
      return result;
    },
    async getPayment(providerPaymentId) { return [...payments.values()].find(item => item.providerPaymentId === providerPaymentId) || null; },
    async verifyWebhook(body) { return body; },
  };
}
module.exports = { createFakePaymentProvider };
