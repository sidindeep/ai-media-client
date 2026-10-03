const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { AccountRecords } = require('../database/records');
const { createMediaService } = require('./media-service');
const { createWallet } = require('../billing/wallet');
const { createPricing } = require('../billing/pricing');
const { createCreditConversion } = require('../billing/conversion');
const { createProviderRouter } = require('./provider-router');
const { transaction, checkDatabase } = require('../database/database');
const { createModelConfigReader } = require('./service-model-configs');
const { createModelRouteSynchronizer } = require('./model-route-sync');
const { lockWallet, increaseReservation, settle } = require('../billing/wallet');
const { generationHistory, generationHistorySince, generationHistoryPage, generationActive, countUnassignedGenerations } = require('./generation-history');
const { spendingHistory } = require('./spending-history');
const { generationJournal } = require('./generation-journal');
const { createWorkspaces } = require('./workspaces');
const { createModelAccess } = require('./model-access');
const trace = require('../generation-log');
const { recordFailure } = require('../provider-diagnostics');
const { ROLES, isAccountRole, isAdminRole, assertAdminAccount, assertAccountAccess } = require('../auth/roles');
function publicRecord(record) {
  // Explicit allowlist: diagnostics, provider task IDs, costs and payloads stay internal.
  const fields = ['id', 'requestId', 'revision', 'state', 'createdAt', 'updatedAt', 'modelId', 'modelName', 'kind', 'input', 'sourceFiles', 'workspace', 'queueHidden', 'nativeQuote',
    'queuedAt', 'preparingAt', 'submittingAt', 'providerAcceptedAt', 'providerChargeConfirmedAt', 'providerFreeConfirmedAt', 'providerFirstCheckedAt', 'providerStateChangedAt', 'lastCheckedAt', 'resultReceivedAt', 'resultSavedAt',
    'progress', 'providerDurationMs', 'generationStartedAt', 'generationCompletedAt', 'generationDurationMs', 'projectId', 'chatId'];
  const result = Object.fromEntries(fields.filter(key => record[key] !== undefined).map(key => [key, record[key]]));
  Object.assign(result, { providerId: 'media', providerName: record.providerName || 'Медиастудия', model: record.modelId,
    taskId: record.id, resultJson: record.resultJson, localFiles: record.localFiles });
  if (['unknown', 'unconfirmed'].includes(record.state)) result.error = record.nativeQuote?.status === 'unavailable'
    ? 'Статус уточняется. Кредиты не списаны; обратитесь в поддержку.'
    : 'Статус уточняется. Резерв сохранён; обратитесь в поддержку.';
  else if (['fail', 'blocked'].includes(record.state)) result.error = record.providerChargeConfirmedAt
    ? 'Генерация не выполнена. Кредиты списаны после подтверждённого расхода у поставщика.'
    : record.nativeQuote?.status === 'unavailable'
      ? 'Генерация не выполнена. Кредиты не списаны.'
      : 'Генерация не выполнена. Резерв возвращён.';
  if (['fail', 'blocked', 'unknown', 'unconfirmed'].includes(record.state) || record.statusError) {
    const errorInfo = require('../provider-errors').forRecord(record);
    const current = record.errorInfo?.category === 'unknown' && errorInfo?.category !== 'unknown'
      ? { ...record, errorInfo, error: errorInfo.message } : record;
    const failure = recordFailure(current, 'Kie.ai').message;
    if (failure) result.error = `${result.error ? result.error + ' ' : ''}${failure}`.slice(0, 4000);
  }
  return result;
}
function createAccounts({ pool, config, provider, legacy, tariffFetcher, starterPack, storage, content = null,
  idleServiceMs = 30 * 60 * 1000 }) {
  if (!Number.isInteger(idleServiceMs) || idleServiceMs < 1) throw new Error('Некорректный срок простоя сервиса аккаунта');
  const services = new Map(), lastUsed = new Map(), closing = new Map();
  const modelPermissions = createModelAccess({ pool, starterPack });
  let closed = false, sweeping = null;
  const wallet = createWallet(pool, { onPurchase: async accountId => {
    const operation = services.get(accountId);
    if (operation) (await operation).events.emit('changed');
  } });
  const pricing = createPricing(config.pricing), workspaces = createWorkspaces(pool, { storage, dataDirectory: config.dataDirectory });
  const conversion = createCreditConversion({ offersFile: config.commerce?.offersFile,
    kieRubPerCredit: config.rubPerCredit });
  const routedProvider = createProviderRouter([provider]);
  async function dispatchDraft(accountId, service, method, args) {
    const suppliedChatId = method === 'saveDrafts' ? args[1]?.chatId || args[0]?.chatId : args[0]?.chatId;
    const { chatId } = await workspaces.assertBinding(accountId, null, suppliedChatId);
    if (method === 'saveDrafts') return service.dispatch(method, [args[0], { chatId }]);
    const draft = await service.dispatch(method, [{ chatId }]);
    return draft ?? (suppliedChatId ? null : service.dispatch(method, []));
  }
  async function get(accountId) {
    const started = Date.now();
    if (closed) throw new Error('Сервис аккаунтов закрыт');
    if (closing.has(accountId)) await closing.get(accountId);
    lastUsed.set(accountId, Date.now());
    const cold = !services.has(accountId);
    if (cold) {
      const stores = Object.fromEntries(['history', 'preferences', 'drafts', 'sources', 'templates', 'presets'].map(name => [name, new AccountRecords(pool, accountId, name)]));
      const operation = createMediaService({ directory: path.join(config.dataDirectory, 'accounts', accountId), provider: routedProvider,
        rubPerCredit: config.rubPerCredit, stores, pricing, conversion, tariffFetcher, storage, storagePrefix: `accounts/${accountId}`, content, accountId,
        background: config.replicaRole !== 'web' });
      services.set(accountId, operation);
      operation.catch(() => services.delete(accountId));
    }
    const service = await services.get(accountId);
    trace.timing('generation.account_service', { cold, elapsedMs: Date.now() - started, poolWaiting: pool.waitingCount ?? null });
    return service;
  }
  async function sweepIdle(now = Date.now()) {
    if (closed) return;
    if (sweeping) return sweeping;
    sweeping = (async () => {
      for (const [accountId, operation] of services) {
        if (now - (lastUsed.get(accountId) || now) < idleServiceMs) continue;
        const service = await operation.catch(() => null);
        if (!service || services.get(accountId) !== operation || now - (lastUsed.get(accountId) || now) < idleServiceMs) continue;
        const queue = service.queue;
        if (queue.running || queue.polling || queue.timer || queue.pollTimer
          || service.events.listenerCount('changed') || service.events.listenerCount('reset')) continue;
        services.delete(accountId);
        lastUsed.delete(accountId);
        const shutdown = service.close().finally(() => closing.delete(accountId));
        closing.set(accountId, shutdown);
        await shutdown;
      }
    })();
    try { await sweeping; } finally { sweeping = null; }
  }
  const sweepTimer = setInterval(() => { void sweepIdle().catch(error => console.error('Account service cleanup:', error)); },
    Math.min(5 * 60 * 1000, Math.max(1000, Math.floor(idleServiceMs / 2))));
  sweepTimer.unref?.();
  return {
    pool, wallet, pricing, conversion, workspaces, starterPack, modelPermissions, content, provider: routedProvider, get, sweepIdle,
    async setModelAccess(actorId, accountId, policy, reason) {
      const access = await modelPermissions.set(actorId, accountId, policy, reason);
      const service = services.get(accountId);
      if (service) (await service).events.emit('changed');
      return access;
    },
    databaseState: options => checkDatabase(pool, options),
    modelConfigs: createModelConfigReader(pool, { refresh: createModelRouteSynchronizer({ pool,
      apiKey: config.apimart?.apiKey, ...(tariffFetcher ? { fetcher: tariffFetcher } : {}) }) }),
    async updateProfile(accountId, name) {
      const value = typeof name === 'string' ? name.trim() : '';
      if (!value || value.length > 200) throw new Error('Укажите имя до 200 символов');
      await pool.query('UPDATE media_accounts SET display_name=$2 WHERE id=$1', [accountId, value]);
      return { name: value };
    },
    async workspaceSyncReadModel(accountId, includeUnassigned) {
      const cursorValue = (await pool.query('SELECT clock_timestamp() AS cursor')).rows[0]?.cursor;
      const cursor = cursorValue instanceof Date ? cursorValue.toISOString() : new Date(cursorValue).toISOString();
      if (!includeUnassigned) return { cursor, unassignedCount: null };
      return { cursor, unassignedCount: await countUnassignedGenerations(pool, accountId) };
    },
    async createTelegramTask(telegramUserId, request, confirmationToken) {
      const identity = (await pool.query('SELECT a.id,a.role FROM media_telegram_links l JOIN media_accounts a ON a.id=l.account_id WHERE l.telegram_user_id=$1', [String(telegramUserId)])).rows[0];
      if (!identity) throw Object.assign(new Error('Сначала привяжите Telegram к аккаунту сайта'), { status: 403 });
      if (!/^[a-f0-9-]{36}$/i.test(String(confirmationToken || ''))) throw new Error('Подтверждение генерации устарело');
      const scoped = await this.scope(identity, identity.id);
      const task = await scoped.dispatch('createTask', [{ ...request, requestId: `telegram:${identity.id}:${confirmationToken}` }]);
      await (await get(identity.id)).history.update(task.id, { telegramUserId: String(telegramUserId) });
      return task;
    },
    async notifyContent(accountId) { const operation = services.get(accountId); if (operation) (await operation).events.emit('changed'); },
    async recover() {
      if (config.replicaRole === 'web') return;
      const rows = (await pool.query("SELECT DISTINCT account_id FROM media_records WHERE namespace='history' AND data->>'state' IN ('queued','preparing','submitting','waiting','queuing','generating','unknown')")).rows;
      for (const row of rows) await get(row.account_id);
    },
    async scope(user, selected) {
      assertAccountAccess(user, selected);
      if (selected === 'legacy') return {
        ...legacy,
        async dispatch(method, args = []) {
          if (method === 'createTask') throw Object.assign(new Error('Для генерации выберите аккаунт с кредитным балансом'), { status: 400, code: 'ACCOUNT_REQUIRED' });
          return legacy.dispatch(method, args);
        }
      };
      const accountId = selected || user.id;
      const account = accountId === user.id ? { id: user.id, role: user.role }
        : /^[a-f0-9-]{36}$/.test(accountId) ? (await pool.query('SELECT id,role FROM media_accounts WHERE id=$1', [accountId])).rows[0] : null;
      if (!account) throw new Error('Аккаунт не найден');
      const service = await get(accountId);
      if (isAdminRole(user.role)) return {
        ...service,
        async dispatch(method, args = []) {
          if (method === 'getBalance') return wallet.get(accountId);
          if (method === 'getSpending') return spendingHistory(pool, accountId, args[0], true);
          if (method === 'getGenerationJournal') return generationJournal(pool, accountId, args[0], true);
          if (method === 'getHistory') return generationHistory(pool, accountId, service);
          if (method === 'getHistoryDelta') return generationHistorySince(pool, accountId, service, args[0]?.since, args[0]?.before, undefined, args[0]?.activeIds);
          if (method === 'getHistoryPage') return generationHistoryPage(pool, accountId, service, args[0]?.cursor, undefined, 50, args[0]?.chatId);
          if (method === 'getHistoryActive') return generationActive(pool, accountId, service);
          if (['loadDrafts', 'saveDrafts'].includes(method)) return dispatchDraft(accountId, service, method, args);
          if (method === 'saveGenerationPreset') return service.dispatch(method, [args[0], { routerAiRole: ROLES.ADMIN }]);
          if (method === 'createTask') {
            const [, binding] = await Promise.all([
              modelPermissions.assertProvider(accountId, account.role, 'media'),
              workspaces.assertBinding(accountId, args[0]?.projectId, args[0]?.chatId),
            ]);
            return service.createTask({ ...args[0], ...binding });
          }
          if (['nativeQuote', 'diagnoseProvider'].includes(method)) await modelPermissions.assertProvider(accountId, account.role, 'media');
          return service.dispatch(method, args);
        }
      };
      return {
        ...service,
        async dispatch(method, args) {
          switch (method) {
            case 'getCatalog': {
              const access = await modelPermissions.status(accountId, account.role);
              if (access.modelAccess === 'gpt-only') return { providers: [], models: [] };
              const catalog = service.catalog();
              return { providers: [{ id: 'media', name: catalog.providers[0]?.name || 'Медиастудия' }], models: catalog.models.map(model => ({
                id: model.id, apiModel: model.id, providerId: 'media', name: model.name, kind: model.kind,
                description: model.description, fields: model.fields, inputSchema: model.inputSchema, startupDefault: model.startupDefault
              })) };
            }
            case 'getHistory': return generationHistory(pool, accountId, service, publicRecord);
            case 'getHistoryDelta': return generationHistorySince(pool, accountId, service, args[0]?.since, args[0]?.before, publicRecord, args[0]?.activeIds);
            case 'getHistoryPage': return generationHistoryPage(pool, accountId, service, args[0]?.cursor, publicRecord, 50, args[0]?.chatId);
            case 'getHistoryActive': return generationActive(pool, accountId, service, publicRecord);
            case 'loadDrafts': case 'saveDrafts': return dispatchDraft(accountId, service, method, args);
            case 'createTask': {
              if (args[0]?.kieAccountId != null && args[0].kieAccountId !== 'primary') throw Object.assign(new Error('Доступ запрещён'), { status: 403 });
              if (!args[0]?.requestId) throw new Error('Требуется идентификатор запроса');
              const started = Date.now();
              const [, binding] = await Promise.all([
                modelPermissions.assertProvider(accountId, account.role, 'media'),
                workspaces.assertBinding(accountId, args[0].projectId, args[0].chatId),
              ]);
              trace.timing('generation.preflight', { elapsedMs: Date.now() - started, poolWaiting: pool.waitingCount ?? null });
              const request = { ...args[0], kieAccountId: 'primary', ...binding };
              return publicRecord(await service.createTask(request));
            }
            case 'getTask': {
              const row = (await service.listHistory()).find(record => record.id === args[1]);
              if (!row) throw new Error('Задача не найдена');
              return publicRecord(row);
            }
            case 'getBalance': return wallet.get(accountId);
            case 'getSpending': return spendingHistory(pool, accountId, args[0]);
            case 'getGenerationJournal': return generationJournal(pool, accountId, args[0]);
            case 'nativeQuote': await modelPermissions.assertProvider(accountId, account.role, 'media'); return service.nativeQuote(args[0]?.modelId, args[0]?.input, args[0]?.sourceFiles);
            case 'diagnoseProvider': await modelPermissions.assertProvider(accountId, account.role, 'media'); return service.diagnoseProvider(args[0]?.modelId, args[0]?.input, args[0]?.sourceFiles);
            case 'nativeLedger': return wallet.ledger(accountId);
            case 'queueStatus': return { paused: service.queue.paused, concurrency: service.queue.concurrency, error: service.queue.error ? 'Очередь приостановлена. Проверьте историю.' : null };
            case 'costSettings': return { rubPerCredit: 0, native: true };
            case 'getTariffs': return { rows: [] };
            case 'getTariffDescriptions': return { entries: {} };
            case 'keyStatus': case 'startQueue': case 'pauseQueue': case 'setConcurrency': case 'cancelQueued':
            case 'removeQueued': case 'clearQueue': case 'acknowledgeTask': case 'getFavoriteModels': case 'setFavoriteModels':
            case 'saveGenerationPreset': return service.dispatch(method, [args[0], { routerAiRole: ROLES.USER }]);
            case 'getModelFavorites': case 'setModelFavorites':
            case 'listTemplates': case 'saveTemplate': case 'removeTemplate': case 'listGenerationPresets': case 'removeGenerationPreset':
            case 'storageSettings': case 'setAutoSave': case 'saveResults': return service.dispatch(method, args);
            default: throw Object.assign(new Error('Доступ запрещён'), { status: 403 });
          }
        }
      };
    },
    async list() {
      const rows = (await pool.query(`SELECT a.id,a.display_name AS name,a.role,a.created_at,w.balance,w.held,ma.data->>'policy' AS model_policy,
        (SELECT string_agg(verified_email,', ') FROM media_identities i WHERE i.account_id=a.id) AS email,
        EXISTS(SELECT 1 FROM media_ledger l WHERE l.account_id=a.id AND l.kind='grant' AND l.reference=$1) AS starter_enrolled,
        EXISTS(SELECT 1 FROM media_ledger l WHERE l.account_id=a.id AND l.kind='purchase') AS starter_paid
        FROM media_accounts a JOIN media_wallets w ON w.account_id=a.id
        LEFT JOIN media_records ma ON ma.account_id=a.id AND ma.namespace='model-access' AND ma.id='policy'
        ORDER BY a.created_at DESC LIMIT 500`, [starterPack?.reference || 'starter-pack-disabled'])).rows;
      return rows.map(row => {
        const starter = starterPack?.summarize(row.role, row.starter_enrolled, row.starter_paid) || null;
        return { ...row, starterPack: starter, modelPermissions: modelPermissions.summarize(row.role, row.model_policy, starter) };
      });
    },
    async starterOverview() {
      if (!starterPack) return null;
      const settings = starterPack.settings();
      const row = (await pool.query(`SELECT
        (SELECT count(DISTINCT account_id) FROM media_ledger WHERE kind='grant' AND reference=$1) AS enrolled,
        (SELECT count(DISTINCT account_id) FROM media_ledger WHERE kind='purchase') AS paid,
        (SELECT count(*) FROM media_accounts a WHERE a.role='user'
          AND EXISTS(SELECT 1 FROM media_ledger l WHERE l.account_id=a.id AND l.kind='grant' AND l.reference=$1)
          AND NOT EXISTS(SELECT 1 FROM media_ledger l WHERE l.account_id=a.id AND l.kind='purchase')) AS active`, [starterPack.reference])).rows[0];
      return { version: settings.version, enabled: settings.enabled, credits: settings.credits,
        modelAccess: 'GPT', unlockEvent: settings.unlockLedgerKind,
        enrolled: Number(row.enrolled), paid: Number(row.paid), active: Number(row.active) };
    },
    async setRole(actorId, accountId, role, reason) {
      if (!isAccountRole(role) || typeof reason !== 'string' || !reason.trim() || reason.length > 500) throw new Error('Укажите роль и причину изменения');
      return transaction(pool, async client => {
        await client.query('SELECT pg_advisory_xact_lock(18274692)');
        await assertAdminAccount(client, actorId);
        const target = (await client.query('SELECT role FROM media_accounts WHERE id=$1 FOR UPDATE', [accountId])).rows[0];
        if (!target) throw Object.assign(new Error('Аккаунт не найден'), { status: 404 });
        if (target.role === role) return true;
        if (isAdminRole(target.role) && role === ROLES.USER && Number((await client.query('SELECT count(*) AS count FROM media_accounts WHERE role=$1', [ROLES.ADMIN])).rows[0].count) <= 1) throw Object.assign(new Error('Нельзя снять роль у последнего администратора'), { status: 409 });
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
      return wallet.auditLedger(accountId);
    },
    async kieSubmissionStatistics(days) {
      const { kieSubmissionStatistics } = require('./kie-submission-statistics');
      return kieSubmissionStatistics(pool, days);
    },
    async billingReconciliation(days) {
      const { billingReconciliation } = require('./billing-reconciliation');
      return billingReconciliation(pool, days);
    },
    async operationsMetrics() {
      const { operationsMetrics } = require('./operations-metrics');
      return operationsMetrics(pool);
    },
    async reconcile(actorId, accountId, jobId, outcome, evidence) {
      if (!['success', 'fail'].includes(outcome) || typeof evidence !== 'string' || !evidence.trim() || evidence.length > 2000) throw new Error('Укажите исход и основание сверки');
      return transaction(pool, async client => {
        await assertAdminAccount(client, actorId);
        const lockedWallet = await lockWallet(client, accountId);
        const prior = (await client.query('SELECT * FROM media_reconciliations WHERE job_id=$1', [jobId])).rows[0];
        if (prior) {
          if (prior.account_id !== accountId || prior.outcome !== outcome || prior.evidence !== evidence) throw new Error('Результат сверки уже зафиксирован иначе');
          return true;
        }
        const row = (await client.query("SELECT namespace,data FROM media_records WHERE account_id=$1 AND namespace IN ('history','codex','apimart') AND id=$2 FOR UPDATE", [accountId, jobId])).rows[0];
        if (!['unknown', 'unconfirmed'].includes(row?.data.state)) throw new Error('Задача не требует ручной сверки');
        const actualCredits = row.namespace === 'apimart' ? row.data.apimartTariffCost?.nativeCredits : null;
        const actualUnits = outcome === 'success' && Number.isFinite(actualCredits) && actualCredits >= 0
          ? Math.ceil(actualCredits * 1000 - 1e-9) : undefined;
        if (actualUnits !== undefined && actualUnits > row.data.nativeQuote?.amountUnits) {
          await increaseReservation(client, accountId, jobId, actualUnits - row.data.nativeQuote.amountUnits, lockedWallet);
        }
        await settle(client, accountId, jobId, outcome, row.data, actualUnits);
        await client.query('INSERT INTO media_reconciliations(job_id,account_id,actor_id,outcome,evidence) VALUES($1,$2,$3,$4,$5)', [jobId, accountId, actorId, outcome, evidence]);
        const record = { ...row.data, state: outcome, error: null, errorInfo: null, billingPending: false,
          reconciled: true, generationCompletedAt: new Date().toISOString(),
          ...(row.namespace === 'apimart' ? { completedAt: new Date().toISOString() } : {}),
          ...(row.namespace === 'apimart' && actualUnits !== undefined ? { nativeQuote: {
            ...row.data.nativeQuote, amountUnits: actualUnits, credits: actualUnits / 1000,
            estimatedCredits: row.data.nativeQuote?.credits, status: 'actual' } } : {}),
          revision: Number(row.data.revision || 0) + 1, updatedAt: new Date().toISOString() };
        await client.query("UPDATE media_records SET data=$3,updated_at=now() WHERE account_id=$1 AND namespace=$4 AND id=$2", [accountId, jobId, JSON.stringify(record), row.namespace]);
        return true;
      });
    },
    async close() {
      closed = true; clearInterval(sweepTimer);
      if (sweeping) await sweeping;
      await Promise.allSettled([...closing.values()]);
      for (const operation of services.values()) await (await operation).close();
      await workspaces.close();
    }
  };
}
module.exports = { createAccounts, publicRecord };
