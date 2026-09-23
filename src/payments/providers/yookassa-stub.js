const { paymentError } = require('../contracts');

// DEBUG checkout boundary: records a pending payment without contacting YooKassa.
function createYooKassaStubProvider() {
  return {
    id: 'yookassa-stub', accountId: 'debug-stub', environment: 'test',
    capabilities: () => ({ paymentMethods: [], refunds: false, partialRefunds: false }),
    async createPayment(request) {
      return { providerPaymentId: `stub-${request.idempotencyKey}`, status: 'pending', resolution: 'known',
        confirmationUrl: null, amountMinor: request.amountMinor, currency: request.currency, test: true };
    },
    async getPayment(providerPaymentId) {
      return { providerPaymentId, status: 'pending', resolution: 'known', confirmationUrl: null, test: true };
    },
    async verifyWebhook() {
      throw paymentError('UNSUPPORTED_METHOD', 'Заглушка не принимает уведомления');
    },
  };
}

module.exports = { createYooKassaStubProvider };
