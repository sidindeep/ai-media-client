const { createCodexModule } = require('./codex-module');
const { createRouterAiModule } = require('./routerai-module');
const { createRouterAiCatalog } = require('../providers/routerai/catalog');
const { createRouterAiClient } = require('../providers/routerai/client');
const { createApimartJobs } = require('../services/apimart-jobs');
const { createCostRouter } = require('../services/cost-router');

function createGenerationSupport(config) {
  return {
    routerAiModels: createRouterAiCatalog(),
    routerAiStatus: config.routerAi?.apiKey ? createRouterAiClient({ apiKey: config.routerAi.apiKey }) : null,
  };
}

function createGenerationServices({ config, accounts, storage, support }) {
  if (!support) throw new Error('Generation support is required');
  const codexModule = accounts && config.codex?.url ? createCodexModule({ accounts, url: config.codex.url,
    dataDirectory: config.dataDirectory, storage, content: accounts.content }) : null;
  const routerAiModule = accounts && config.routerAi?.apiKey ? createRouterAiModule({ accounts,
    apiKey: config.routerAi.apiKey, catalog: support.routerAiModels }) : null;
  const services = {
    ...support,
    codex: codexModule?.provider || null,
    codexAdmin: codexModule?.admin || null,
    routerAi: routerAiModule?.provider || null,
    routerAiAdmin: routerAiModule?.admin || null,
    apimart: accounts && config.apimart?.apiKey ? createApimartJobs({ pool: accounts.pool,
      content: accounts.content, apiKey: config.apimart.apiKey }) : null,
  };
  return { ...services,
    costRouter: accounts ? createCostRouter({ accounts, apimart: services.apimart, pool: accounts.pool }) : null,
    codexProvider: services.codex };
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
