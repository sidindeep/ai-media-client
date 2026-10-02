const { createProviders } = require('./providers');
const { createEmailAuth } = require('./email');
const { createMaxAuth } = require('./max-login');
const { createOAuthAuth, hash, cookieValue } = require('./oauth');

// Product composition: reusable OAuth core plus the existing email/MAX integrations.
function createAuth({ pool, config, providers = createProviders(config), store, registerAccount }) {
  const { issueSession, ...oauth } = createOAuthAuth({ store, providers, origin: config.origin,
    sessionSeconds: config.sessionSeconds, cookiePrefix: 'media' });
  const email = createEmailAuth({ pool, config, registerAccount, issueSession });
  const max = createMaxAuth({ pool, config, registerAccount, issueSession, cookieValue });
  return {
    ...oauth,
    email,
    max,
    providers: () => oauth.providers()
      .concat(max ? [{ id: 'max', label: 'MAX' }] : [], email ? [{ id: 'email', label: 'Email' }] : []),
    providerChoices: () => [
      { id: 'google', label: 'Google' }, { id: 'vk', label: 'VK' },
      { id: 'yandex', label: 'Яндекс' }, { id: 'telegram', label: 'Telegram' },
      { id: 'max', label: 'MAX' }, { id: 'email', label: 'Email' }
    ].map(provider => ({ ...provider, enabled: provider.id === 'max' ? Boolean(max)
      : provider.id === 'email' ? Boolean(email) : providers.has(provider.id) })),
  };
}
module.exports = { createAuth, hash, cookieValue };
