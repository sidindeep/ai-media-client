const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { AccountRecords } = require('../database/records');
const { createMediaService } = require('./media-service');
const { createWallet } = require('../billing/wallet');
const { createPricing } = require('../billing/pricing');
const { createProviderRouter } = require('./provider-router');
const { transaction } = require('../database/database');
const { lockWallet, settle } = require('../billing/wallet');
const { generationHistory } = require('./generation-history');
const { createWorkspaces } = require('./workspaces');
function publicRecord(record) {
  // Explicit allowlist: diagnostics, provider task IDs, costs and payloads stay internal.
  const fields = ['id', 'state', 'createdAt', 'updatedAt', 'modelId', 'modelName', 'kind', 'input', 'sourceFiles', 'workspace', 'queueHidden', 'nativeQuote', 'generationStartedAt', 'generationCompletedAt', 'generationDurationMs', 'projectId', 'chatId'];
  const result = Object.fromEntries(fields.filter(key => record[key] !== undefined).map(key => [key, record[key]]));
  Object.assign(result, { providerId: 'media', providerName: record.providerName || 'Медиастудия', model: record.modelId,
    taskId: record.id, resultJson: record.resultJson, localFiles: record.localFiles });
  if (['unknown', 'unconfirmed'].includes(record.state)) result.error = 'Статус уточняется. Резерв сохранён; обратитесь в поддержку.';
  else if (['fail', 'blocked'].includes(record.state)) result.error = 'Генерация не выполнена. Резерв возвращён.';
  return result;
}
function createAccounts({ pool, config, provider, legacy }) {
  const services = new Map(), wallet = createWallet(pool), pricing = createPricing(config.pricing), workspaces = createWorkspaces(pool);
  const routedProvider = createProviderRouter([provider]);
  async function get(accountId) {
    if (!services.has(accountId)) {
      const stores = Object.fromEntries(['history', 'preferences', 'drafts', 'sources', 'templates'].map(name => [name, new AccountRecords(pool, accountId, name)]));
      const operation = createMediaService({ directory: path.join(config.dataDirectory, 'accounts', accountId), provider: routedProvider,
        rubPerCredit: config.rubPerCredit, stores, pricing });
      services.set(accountId, operation);
      operation.catch(() => services.delete(accountId));
    }
    return services.get(accountId);
  }
  return {
    pool, wallet, pricing, workspaces, get,
    async recover() {
      const rows = (await pool.query("SELECT DISTINCT account_id FROM media_records WHERE namespace='history' AND data->>'state' IN ('preparing','submitting','waiting','queuing','generating','unknown')")).rows;
      for (const row of rows) await get(row.account_id);
    },
    async scope(user, selected) {
      if (selected && user.role !== 'admin') throw Object.assign(new Error('Доступ запрещён'), { status: 403 });
      if (selected === 'legacy') return {
        ...legacy,
        async dispatch(method, args = []) {
          if (method === 'createTask') throw new Error('Для генерации выберите аккаунт с кредитным балансом');
          return legacy.dispatch(method, args);
        }
      };
      const accountId = selected || user.id;
      if (!/^[a-f0-9-]{36}$/.test(accountId) || !(await pool.query('SELECT id FROM media_accounts WHERE id=$1', [accountId])).rowCount) throw new Error('Аккаунт не найден');
      const service = await get(accountId);
      if (user.role === 'admin') return {
        ...service,
        async dispatch(method, args = []) {
          if (method === 'getBalance') return wallet.get(accountId);
          if (method === 'getHistory') return generationHistory(pool, accountId, service);
          if (method === 'createTask') return service.createTask({ ...args[0], ...(await workspaces.assertBinding(accountId, args[0]?.projectId, args[0]?.chatId)) });
          return service.dispatch(method, args);
        }
      };
      return {
        ...service,
        async dispatch(method, args) {
          switch (method) {
            case 'getCatalog': {
              const catalog = service.catalog();
              return { providers: [{ id: 'media', name: catalog.providers[0]?.name || 'Медиастудия' }], models: catalog.models.map(model => ({
                id: model.id, apiModel: model.id, providerId: 'media', name: model.name, kind: model.kind,
                description: model.description, fields: model.fields, inputSchema: model.inputSchema, startupDefault: model.startupDefault
              })) };
            }
            case 'getHistory': return generationHistory(pool, accountId, service, publicRecord);
            case 'createTask': {
              if (!args[0]?.requestId) throw new Error('Требуется идентификатор запроса');
              const request = { ...args[0], ...(await workspaces.assertBinding(accountId, args[0].projectId, args[0].chatId)) };
              return publicRecord(await service.createTask(request));
            }
            case 'getTask': {
              const row = (await service.listHistory()).find(record => record.id === args[1]);
              if (!row) throw new Error('Задача не найдена');
              return publicRecord(row);
            }
            case 'getBalance': return wallet.get(accountId);
            case 'nativeQuote': return service.nativeQuote(args[0]?.modelId, args[0]?.input);
            case 'diagnoseProvider': return service.diagnoseProvider(args[0]?.modelId, args[0]?.input);
            case 'nativeLedger': return wallet.ledger(accountId);
            case 'queueStatus': return { paused: service.queue.paused, concurrency: service.queue.concurrency, error: service.queue.error ? 'Очередь приостановлена. Проверьте историю.' : null };
            case 'costSettings': return { rubPerCredit: 0, native: true };
            case 'getTariffs': return { rows: [] };
            case 'getTariffDescriptions': return { entries: {} };
            case 'keyStatus': case 'startQueue': case 'pauseQueue': case 'setConcurrency': case 'cancelQueued':
            case 'removeQueued': case 'clearQueue': case 'acknowledgeTask': case 'getFavoriteModels': case 'setFavoriteModels':
            case 'listTemplates': case 'saveTemplate': case 'removeTemplate': case 'loadDrafts': case 'saveDrafts':
            case 'storageSettings': case 'setAutoSave': case 'saveResults': return service.dispatch(method, args);
            default: throw Object.assign(new Error('Доступ запрещён'), { status: 403 });
          }
        }
      };
    },
    async list() {
      return (await pool.query('SELECT a.id,a.display_name AS name,a.role,a.created_at,w.balance,w.held,(SELECT string_agg(verified_email,\', \') FROM media_identities i WHERE i.account_id=a.id) AS email FROM media_accounts a JOIN media_wallets w ON w.account_id=a.id ORDER BY a.created_at DESC LIMIT 500')).rows;
    },
    async setRole(actorId, accountId, role, reason) {
      if (!['admin', 'user'].includes(role) || typeof reason !== 'string' || !reason.trim() || reason.length > 500) throw new Error('Укажите роль и причину изменения');
      return transaction(pool, async client => {
        await client.query('SELECT pg_advisory_xact_lock(18274692)');
        const actor = (await client.query('SELECT role FROM media_accounts WHERE id=$1', [actorId])).rows[0];
        if (actor?.role !== 'admin') throw Object.assign(new Error('Доступ запрещён'), { status: 403 });
        const target = (await client.query('SELECT role FROM media_accounts WHERE id=$1 FOR UPDATE', [accountId])).rows[0];
        if (!target) throw Object.assign(new Error('Аккаунт не найден'), { status: 404 });
        if (target.role === role) return true;
        if (target.role === 'admin' && role === 'user' && Number((await client.query("SELECT count(*) AS count FROM media_accounts WHERE role='admin'")).rows[0].count) <= 1) throw Object.assign(new Error('Нельзя снять роль у последнего администратора'), { status: 409 });
        await client.query('UPDATE media_accounts SET role=$2 WHERE id=$1', [accountId, role]);
        await client.query('INSERT INTO media_role_audit(id,account_id,actor_id,old_role,new_role,reason) VALUES($1,$2,$3,$4,$5,$6)', [randomUUID(), accountId, actorId, target.role, role, reason.trim()]);
        await client.query('DELETE FROM media_sessions WHERE account_id=$1', [accountId]);
        return true;
      });
    },
    async audit() {
      return (await pool.query('SELECT r.*,a.display_name AS name FROM media_role_audit r JOIN media_accounts a ON a.id=r.account_id ORDER BY r.created_at DESC LIMIT 100')).rows;
    },
    async ledger(accountId) {
      return (await pool.query('SELECT kind,amount,note,actor_id,created_at FROM media_ledger WHERE account_id=$1 ORDER BY created_at DESC LIMIT 200', [accountId])).rows;
    },
    async reconcile(actorId, accountId, jobId, outcome, evidence) {
      if (!['success', 'fail'].includes(outcome) || typeof evidence !== 'string' || !evidence.trim() || evidence.length > 2000) throw new Error('Укажите исход и основание сверки');
      return transaction(pool, async client => {
        if ((await client.query('SELECT role FROM media_accounts WHERE id=$1', [actorId])).rows[0]?.role !== 'admin') throw Object.assign(new Error('Доступ запрещён'), { status: 403 });
        await lockWallet(client, accountId);
        const prior = (await client.query('SELECT * FROM media_reconciliations WHERE job_id=$1', [jobId])).rows[0];
        if (prior) {
          if (prior.account_id !== accountId || prior.outcome !== outcome || prior.evidence !== evidence) throw new Error('Результат сверки уже зафиксирован иначе');
          return true;
        }
        const row = (await client.query("SELECT namespace,data FROM media_records WHERE account_id=$1 AND namespace IN ('history','codex') AND id=$2 FOR UPDATE", [accountId, jobId])).rows[0];
        if (!['unknown', 'unconfirmed'].includes(row?.data.state)) throw new Error('Задача не требует ручной сверки');
        await settle(client, accountId, jobId, outcome);
        await client.query('INSERT INTO media_reconciliations(job_id,account_id,actor_id,outcome,evidence) VALUES($1,$2,$3,$4,$5)', [jobId, accountId, actorId, outcome, evidence]);
        const record = { ...row.data, state: outcome, error: null, errorInfo: null, reconciled: true, generationCompletedAt: new Date().toISOString() };
        await client.query("UPDATE media_records SET data=$3,updated_at=now() WHERE account_id=$1 AND namespace=$4 AND id=$2", [accountId, jobId, JSON.stringify(record), row.namespace]);
        return true;
      });
    },
    async close() { for (const operation of services.values()) await (await operation).close(); await workspaces.close(); }
  };
}
module.exports = { createAccounts, publicRecord };
