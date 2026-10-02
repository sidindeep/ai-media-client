const { randomUUID } = require('node:crypto');
const { ensureDefaultChatRow } = require('./workspaces');
const { isAccountRole } = require('../auth/roles');

// Uses the caller's transaction so identity, credentials and session remain atomic.
function createAccountRegistration({ starterPack } = {}) {
  return async function registerAccount(client, { name, role = 'user' }) {
    if (!isAccountRole(role)) throw new Error('Некорректная роль аккаунта');
    const accountId = randomUUID();
    await client.query('INSERT INTO media_accounts(id,display_name,role) VALUES($1,$2,$3)',
      [accountId, String(name).slice(0, 200), role]);
    if (starterPack) await starterPack.enroll(client, accountId, role);
    else await client.query('INSERT INTO media_wallets(account_id) VALUES($1)', [accountId]);
    await ensureDefaultChatRow(client, accountId);
    return accountId;
  };
}

module.exports = { createAccountRegistration };
