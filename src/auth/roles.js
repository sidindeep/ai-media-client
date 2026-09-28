const ROLES = Object.freeze({ USER: 'user', ADMIN: 'admin' });

function isAccountRole(role) {
  return role === ROLES.USER || role === ROLES.ADMIN;
}

function isAdminRole(role) {
  return role === ROLES.ADMIN;
}

function forbidden() {
  return Object.assign(new Error('Доступ запрещён'), { status: 403 });
}

function assertAdminRole(role) {
  if (!isAdminRole(role)) throw forbidden();
}

async function assertAdminAccount(executor, accountId) {
  const account = (await executor.query('SELECT role FROM media_accounts WHERE id=$1', [accountId])).rows[0];
  assertAdminRole(account?.role);
}

function assertAccountAccess(actor, accountId) {
  if (accountId && accountId !== actor?.id) assertAdminRole(actor?.role);
}

module.exports = { ROLES, isAccountRole, isAdminRole, assertAdminRole, assertAdminAccount, assertAccountAccess };
