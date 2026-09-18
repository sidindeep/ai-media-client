const path = require('node:path');
const { AccountRecords } = require('../database/records');
const { createMediaService } = require('./media-service');
const { createWallet } = require('../billing/wallet');
const { createPricing } = require('../billing/pricing');
const { createProviderRouter } = require('./provider-router');
const { transaction } = require('../database/database');
const { lockWallet, settle } = require('../billing/wallet');
function publicRecord(record) {
  // Explicit allowlist: diagnostics, provider task IDs, costs and payloads stay internal.
  const fields = ['id', 'state', 'createdAt', 'updatedAt', 'modelId', 'modelName', 'kind', 'input', 'sourceFiles', 'workspace', 'queueHidden', 'nativeQuote', 'generationStartedAt', 'generationCompletedAt', 'generationDurationMs'];
  const result = Object.fromEntries(fields.filter(key => record[key] !== undefined).map(key => [key, record[key]]));
  Object.assign(result, { providerId: 'media', providerName: 'Медиастудия', model: record.modelId,
    taskId: record.id, resultJson: record.resultJson, localFiles: record.localFiles });
  if (['unknown', 'unconfirmed'].includes(record.state)) result.error = 'Статус уточняется. Резерв сохранён; обратитесь в поддержку.';
  else if (['fail', 'blocked'].includes(record.state)) result.error = 'Генерация не выполнена. Резерв возвращён.';
  return result;
}
function createAccounts({ pool, config, provider, legacy }) {
  const services = new Map(), wallet = createWallet(pool), pricing = createPricing(config.pricing);
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
    pool, wallet, pricing, get,
    async recover() {
      const rows = (await pool.query("SELECT DISTINCT account_id FROM media_records WHERE namespace='history' AND data->>'state' IN ('preparing','submitting','waiting','queuing','generating','unknown')")).rows;
      for (const row of rows) await get(row.account_id);
    },
    async scope(user, selected) {
      if (selected && user.role !== 'admin') throw Object.assign(new Error('Доступ запрещён'), { status: 403 });
      if (selected === 'legacy') return legacy;
      const accountId = selected || user.id;
      if (!/^[a-f0-9-]{36}$/.test(accountId) || !(await pool.query('SELECT id FROM media_accounts WHERE id=$1', [accountId])).rowCount) throw new Error('Аккаунт не найден');
      const service = await get(accountId);
      if (user.role === 'admin') return service;
      return {
        ...service,
        async dispatch(method, args) {
          switch (method) {
            case 'getCatalog': {
              const catalog = service.catalog();
              return { providers: [{ id: 'media', name: 'Медиастудия' }], models: catalog.models.map(model => ({
                id: model.id, apiModel: model.id, providerId: 'media', name: model.name, kind: model.kind,
                fields: model.fields, inputSchema: model.inputSchema, startupDefault: model.startupDefault
              })) };
            }
            case 'getHistory': return (await service.listHistory()).map(publicRecord);
            case 'createTask': {
              if (!args[0]?.requestId) throw new Error('Требуется идентификатор запроса');
              return publicRecord(await service.createTask(args[0]));
            }
            case 'getTask': {
              const row = (await service.listHistory()).find(record => record.id === args[1]);
              if (!row) throw new Error('Задача не найдена');
              return publicRecord(row);
            }
            case 'getBalance': return wallet.get(accountId);
            case 'nativeQuote': return pricing.quote(args[0]?.modelId, args[0]?.input);
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
      return (await pool.query('SELECT a.id,a.display_name AS name,a.role,a.created_at,w.balance,w.held FROM media_accounts a JOIN media_wallets w ON w.account_id=a.id ORDER BY a.created_at DESC LIMIT 500')).rows;
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
        const row = (await client.query("SELECT data FROM media_records WHERE account_id=$1 AND namespace='history' AND id=$2 FOR UPDATE", [accountId, jobId])).rows[0];
        if (!['unknown', 'unconfirmed'].includes(row?.data.state)) throw new Error('Задача не требует ручной сверки');
        await settle(client, accountId, jobId, outcome);
        await client.query('INSERT INTO media_reconciliations(job_id,account_id,actor_id,outcome,evidence) VALUES($1,$2,$3,$4,$5)', [jobId, accountId, actorId, outcome, evidence]);
        const record = { ...row.data, state: outcome, error: null, errorInfo: null, reconciled: true, generationCompletedAt: new Date().toISOString() };
        await client.query("UPDATE media_records SET data=$3,updated_at=now() WHERE account_id=$1 AND namespace='history' AND id=$2", [accountId, jobId, JSON.stringify(record)]);
        return true;
      });
    },
    async close() { for (const operation of services.values()) await (await operation).close(); }
  };
}
module.exports = { createAccounts, publicRecord };
