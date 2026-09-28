const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ROLES, isAccountRole, isAdminRole, assertAdminRole, assertAdminAccount, assertAccountAccess } = require('../src/auth/roles');

test('shared role policy grants admin access and fails closed for missing or unknown roles', async () => {
  assert.equal(isAccountRole(ROLES.USER), true);
  assert.equal(isAccountRole(ROLES.ADMIN), true);
  assert.equal(isAccountRole('owner'), false);
  assert.equal(isAdminRole(ROLES.ADMIN), true);
  for (const role of [ROLES.USER, 'owner', undefined, null]) {
    assert.throws(() => assertAdminRole(role), { status: 403 });
  }
  assert.doesNotThrow(() => assertAdminRole(ROLES.ADMIN));

  const actor = { id: 'own', role: ROLES.USER };
  assert.doesNotThrow(() => assertAccountAccess(actor, 'own'));
  assert.throws(() => assertAccountAccess(actor, 'other'), { status: 403 });
  assert.doesNotThrow(() => assertAccountAccess({ ...actor, role: ROLES.ADMIN }, 'other'));

  const executor = { query: async (_sql, [id]) => ({ rows: id === 'admin' ? [{ role: ROLES.ADMIN }] : [] }) };
  await assert.doesNotReject(assertAdminAccount(executor, 'admin'));
  await assert.rejects(assertAdminAccount(executor, 'missing'), { status: 403 });
});
