const { defineProvider } = require('../contract');

function createRouterAiApplicationProvider({ billing, catalog, client }) {
  return defineProvider({
    id: 'routerai', name: 'RouterAI', kinds: ['text', 'image'],
    billing: { mode: 'wallet', unit: 'credits' },
    listModels: async role => (await catalog.list(role)).models,
    listModelCatalog: role => catalog.list(role),
    validateRequest: require('./request').validateRouterAiRequest,
    async quote(request, role) {
      const nativeQuote = await billing.quote(request, role);
      return { status: nativeQuote.amountUnits == null ? 'unavailable' : 'exact',
        credits: nativeQuote.credits ?? null, nativeQuote };
    },
    submit: (account, request, role, models) => billing.submit(account, request, role, models),
    getTask: (account, requestId) => billing.get(account, requestId),
    getImage: (account, requestId) => billing.image(account, requestId),
    getStatus: async () => ({ configured: true, balance: await client.credits(), unit: 'rub' }),
    recover: () => billing.recover(),
    close: () => billing.close(),
  });
}

module.exports = { createRouterAiApplicationProvider };
