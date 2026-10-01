const { createCodexRecords } = require('../generations/codex-records');
const { createCodexWorkerClient } = require('../providers/codex/worker-client');
const { createCodexBilling } = require('../services/codex-billing');
const { createCodexApplicationProvider } = require('../providers/codex/application');
const { createCreditConversion } = require('../billing/conversion');

// Composition only. Consumers receive operations; pool, worker URL and wallet
// internals never escape through the module's public provider facade.
function createCodexModule({ accounts, url, fetchImpl, ...options }) {
  const worker = createCodexWorkerClient({ url, fetchImpl });
  const billing = createCodexBilling({ ...options, worker, records: createCodexRecords({ pool: accounts.pool }),
    pricing: accounts.pricing, conversion: accounts.conversion || createCreditConversion(),
    content: options.content === undefined ? accounts.content : options.content });
  return { billing, provider: createCodexApplicationProvider(billing),
    admin: Object.freeze({ auth: worker.auth, limits: account => worker.auth(account, 'limits') }) };
}

module.exports = { createCodexModule };
