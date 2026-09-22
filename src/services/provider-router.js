// Routing seam: one provider today. Never retry a submission through a second provider.
function createProviderRouter(providers) {
  const byId = new Map(providers.map(provider => [provider.id, provider]));
  const primary = providers[0];
  if (!primary) throw new Error('Не настроен провайдер');
  const select = model => {
    const provider = byId.get(model.providerId);
    if (!provider) throw new Error('Провайдер модели недоступен');
    return provider;
  };
  return { id: primary.id, isConfigured: () => primary.isConfigured(),
    ...(primary.selectAccount ? { selectAccount: id => primary.selectAccount(id), listAccounts: () => primary.listAccounts() } : {}),
    upload: file => primary.upload(file), balance: () => primary.balance(),
    create: (model, input) => select(model).create(model, input),
    poll: (model, taskId) => select(model).poll(model, taskId) };
}
module.exports = { createProviderRouter };
