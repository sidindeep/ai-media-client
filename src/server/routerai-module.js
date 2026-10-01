const { createRouterAiRecords } = require('../generations/routerai-records');
const { createRouterAiClient } = require('../providers/routerai/client');
const { createRouterAiApplicationProvider } = require('../providers/routerai/application');
const { createRouterAiBilling } = require('../services/routerai-billing');
const { createCreditConversion } = require('../billing/conversion');

function createRouterAiModule({ accounts, apiKey, catalog, fetchImpl, ...options }) {
  const client = createRouterAiClient({ apiKey, ...(fetchImpl ? { fetchImpl } : {}) });
  const billing = createRouterAiBilling({ ...options, client,
    records: createRouterAiRecords({ pool: accounts.pool }),
    conversion: accounts.conversion || createCreditConversion(),
    content: options.content === undefined ? accounts.content : options.content,
    tariffFetcher: options.tariffFetcher || catalog?.tariff });
  return { billing,
    provider: catalog ? createRouterAiApplicationProvider({ billing, catalog, client }) : null,
    admin: Object.freeze({ listModels: role => catalog.all(role),
      submit: (account, request, models) => billing.submitAdmin(account, request, models),
      getVideo: (account, requestId, contentFile) => billing.adminVideo(account, requestId, contentFile) }),
  };
}

module.exports = { createRouterAiModule };
