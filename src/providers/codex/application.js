const { defineProvider } = require('../contract');

function createCodexApplicationProvider(billing) {
  return defineProvider({
    id: 'codex', name: 'Codex CLI', kinds: ['text', 'image'],
    billing: { mode: 'wallet', unit: 'credits' },
    listModels: async () => (await billing.models()).models,
    quote(request) {
      const nativeQuote = billing.quote(request);
      return { status: 'exact', credits: nativeQuote.credits, nativeQuote };
    },
    submit: (account, request) => billing.submit(account, request),
    getTask: (account, requestId) => billing.read(account, requestId),
    getStatus: () => ({ configured: true, balance: null, unit: null }),
  });
}

module.exports = { createCodexApplicationProvider };
