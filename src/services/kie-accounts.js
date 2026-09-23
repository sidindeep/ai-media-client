const { createKieGeneration } = require('./kie-generation');
const { createKieCreateLimiter } = require('./kie-create-limiter');

// Credentials stay on the server. A saved account ID routes every phase of a job.
async function createKieAccounts({ primaryKey = '', secondaryKey = '', createProvider = createKieGeneration } = {}) {
  const limiters = new Map();
  const entries = await Promise.all([
    ['primary', 'Kie.ai · 1', primaryKey],
    ['secondary', 'Kie.ai · Sid', secondaryKey],
  ].map(async ([id, name, apiKey]) => {
    const provider = await createProvider({ apiKey });
    const credential = apiKey || id;
    if (!limiters.has(credential)) limiters.set(credential, createKieCreateLimiter());
    const limiter = limiters.get(credential);
    return { id, name, provider: {
      ...provider,
      waitForCreate: () => limiter.wait(),
      rateLimited: () => limiter.rateLimited()
    } };
  }));
  function selectAccount(id = 'primary') {
    const entry = entries.find(item => item.id === id);
    if (!entry) throw new Error('Неизвестный аккаунт Kie');
    return entry.provider;
  }
  return {
    ...selectAccount(),
    selectAccount,
    listAccounts: () => entries.map(({ id, name, provider }) => ({ id, name, configured: provider.isConfigured() })),
  };
}
module.exports = { createKieAccounts };
