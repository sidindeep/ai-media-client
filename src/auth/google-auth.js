const { createOAuthAuth } = require('./oauth');
const { createGoogleProvider } = require('./google');

function createGoogleAuth({ clientId, clientSecret, fetcher, ...options }) {
  return createOAuthAuth({ ...options,
    providers: new Map([['google', createGoogleProvider({ clientId, clientSecret, fetcher })]]) });
}

module.exports = { createGoogleAuth };
