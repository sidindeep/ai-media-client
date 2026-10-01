const { defineProvider } = require('../contract');

function createCodexApplicationProvider(billing) {
  return defineProvider({
    id: 'codex', name: 'Codex CLI', kinds: ['text', 'image'],
    billing: { mode: 'wallet', unit: 'credits' },
    listModels: async () => (await billing.models()).models,
    listModelCatalog: () => billing.models(),
    quote(request) {
      const nativeQuote = billing.quote(request);
      return { status: 'exact', credits: nativeQuote.credits, nativeQuote };
    },
    submit: (account, request) => billing.submit(account, request),
    getTask: (account, requestId) => billing.read(account, requestId),
    getImage: (account, requestId) => billing.image(account, requestId),
    refreshTask: (account, requestId) => billing.status(account, requestId),
    recover: () => billing.recover(),
    close: () => billing.close(),
    getStatus: () => ({ configured: true, balance: null, unit: null }),
  });
}

module.exports = { createCodexApplicationProvider };
