const { createCodexBilling } = require('../services/codex-billing');
const { createRouterAiBilling } = require('../services/routerai-billing');
const { createRouterAiCatalog } = require('../providers/routerai/catalog');
const { createRouterAiClient } = require('../providers/routerai/client');
const { createApimartJobs } = require('../services/apimart-jobs');
const { createCodexApplicationProvider } = require('../providers/codex/application');
const { createCostRouter } = require('../services/cost-router');

function createGenerationSupport(config) {
  return {
    routerAiModels: createRouterAiCatalog(),
    routerAiStatus: config.routerAi?.apiKey ? createRouterAiClient({ apiKey: config.routerAi.apiKey }) : null,
  };
}

function createGenerationServices({ config, accounts, storage, support }) {
  if (!support) throw new Error('Generation support is required');
  const services = {
    ...support,
    codex: accounts && config.codex?.url ? createCodexBilling({ accounts, url: config.codex.url,
      dataDirectory: config.dataDirectory, storage, content: accounts.content }) : null,
    routerAi: accounts && config.routerAi?.apiKey ? createRouterAiBilling({ accounts, apiKey: config.routerAi.apiKey,
      content: accounts.content, tariffFetcher: support.routerAiModels.tariff }) : null,
    apimart: accounts && config.apimart?.apiKey ? createApimartJobs({ pool: accounts.pool,
      content: accounts.content, apiKey: config.apimart.apiKey }) : null,
  };
  return { ...services,
    costRouter: accounts ? createCostRouter({ accounts, apimart: services.apimart, pool: accounts.pool }) : null,
    codexProvider: services.codex ? createCodexApplicationProvider(services.codex) : null };
}

async function recoverGenerationServices(services) {
  await services.codex?.recover();
  await services.routerAi?.recover();
  await services.apimart?.recover();
}

function closeGenerationServices(services) {
  services?.codex?.close();
  services?.routerAi?.close();
}

module.exports = { createGenerationSupport, createGenerationServices, recoverGenerationServices, closeGenerationServices };
