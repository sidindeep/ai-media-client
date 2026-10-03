const { randomUUID } = require('node:crypto');
const { transaction } = require('../database/database');
const { assertAdminAccount, isAdminRole } = require('../auth/roles');

// Accounts owns this policy. Starter-pack restrictions remain an independent gate.
function createModelAccess({ pool, starterPack }) {
  function summarize(role, value, starter) {
    const policy = value === 'gpt-only' ? 'gpt-only' : 'all';
    return { policy, modelAccess: isAdminRole(role) ? 'all' : policy === 'gpt-only' || starter?.active ? 'gpt-only' : 'all' };
  }
  async function status(accountId, role, executor = pool) {
    const row = (await executor.query("SELECT data FROM media_records WHERE account_id=$1 AND namespace='model-access' AND id='policy'", [accountId])).rows[0];
    const starter = await starterPack?.status(accountId, role, executor);
    return summarize(role, row?.data?.policy, starter);
  }
  return {
    status,
    summarize,
    async assertProvider(accountId, role, provider, executor = pool) {
      const access = await status(accountId, role, executor);
      if (!isAdminRole(role) && access.policy === 'gpt-only' && provider !== 'codex') {
        throw Object.assign(new Error('Доступ к медиа-моделям ограничен администратором.'), { status: 403, code: 'MODEL_ACCESS_RESTRICTED' });
      }
      await starterPack?.assertProvider(accountId, role, provider, executor);
      return access;
    },
    async set(actorId, accountId, policy, reason) {
      if (!['gpt-only', 'all'].includes(policy) || typeof reason !== 'string' || !reason.trim() || reason.length > 500) {
        throw Object.assign(new Error('Укажите доступ к моделям и причину изменения'), { status: 400 });
      }
      return transaction(pool, async client => {
        await assertAdminAccount(client, actorId);
        const target = (await client.query('SELECT role FROM media_accounts WHERE id=$1 FOR UPDATE', [accountId])).rows[0];
        if (!target) throw Object.assign(new Error('Аккаунт не найден'), { status: 404 });
        if (isAdminRole(target.role)) throw Object.assign(new Error('Ограничения моделей задаются только пользователям'), { status: 400 });
        const previous = await status(accountId, target.role, client);
        await client.query(`INSERT INTO media_records(account_id,namespace,id,data) VALUES($1,'model-access','policy',$2)
          ON CONFLICT(account_id,namespace,id) DO UPDATE SET data=EXCLUDED.data,updated_at=now()`, [accountId, JSON.stringify({ policy })]);
        await client.query("INSERT INTO media_records(account_id,namespace,id,data) VALUES($1,'model-access-audit',$2,$3)",
          [accountId, randomUUID(), JSON.stringify({ actorId, oldPolicy: previous.policy, policy, reason: reason.trim(), createdAt: new Date().toISOString() })]);
        return status(accountId, target.role, client);
      });
    },
  };
}

module.exports = { createModelAccess };
