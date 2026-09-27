const { transaction } = require('./database');
const { reserve, settle, lockWallet } = require('../billing/wallet');
const { units } = require('../billing/pricing');
const trace = require('../generation-log');
const { appendGenerationEvent, generationEventEntry } = require('../services/generation-journal');
async function journalKieSubmission(client, accountId, old, record) {
  if (record.state === 'submitting' && old?.state !== 'submitting') {
    await client.query(`INSERT INTO media_kie_submissions
      (account_id,job_id,request_id,kie_account_id,project_id,chat_id,model_id,started_at,outcome)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending')`,
    [accountId,record.id,record.requestId || null,record.kieAccountId || 'primary',record.projectId || null,
      record.chatId || null,record.modelId || null,record.submittingAt || new Date().toISOString()]);
  } else if (old?.state === 'submitting' && record.state !== 'submitting') {
    const outcome = record.state === 'waiting' ? 'accepted' : record.state === 'unknown' ? 'unknown' : 'rejected';
    await client.query(`UPDATE media_kie_submissions SET outcome=$3,finished_at=now(),provider_task_id=$4,error_code=$5,error_message=$6
      WHERE id=(SELECT id FROM media_kie_submissions WHERE account_id=$1 AND job_id=$2 AND outcome='pending' ORDER BY id DESC LIMIT 1)`,
    [accountId,record.id,outcome,record.taskId || null,record.errorInfo?.code ? String(record.errorInfo.code).slice(0,100) : null,
      record.error ? String(trace.clean(record.error)).slice(0,500) : null]);
    if (outcome === 'unknown') trace.run(record, () => trace.write('kie.submit.unknown', { reason: record.errorInfo?.code || 'lost-response', accountId, chatId: record.chatId, kieAccountId: record.kieAccountId }));
  }
}
class AccountRecords {
  constructor(pool, accountId, namespace) { Object.assign(this, { pool, accountId, namespace }); }
  async createQueued(id, changes) {
    if (this.namespace !== 'history' || changes.state !== 'queued') throw new Error('Некорректное создание задачи');
    const record = { id, ...changes, revision: 1, updatedAt: new Date().toISOString() };
    const item = generationEventEntry('kie', record, 'created');
    const amount = record.nativeQuote?.amountUnits ? units(record.nativeQuote.amountUnits) : 0;
    if (amount) {
      const result = await this.pool.query(`WITH wallet AS (
        UPDATE media_wallets SET held=held+$3
        WHERE account_id=$1 AND balance-held >= $3 RETURNING account_id
      ), reservation AS (
        INSERT INTO media_reservations(job_id,account_id,amount,price_version,state)
        SELECT $2,account_id,$3,$4,'held' FROM wallet RETURNING account_id
      ), reserve_ledger AS (
        INSERT INTO media_ledger(id,account_id,kind,reference,amount)
        SELECT $5,account_id,'reserve',$2,$3 FROM reservation RETURNING account_id
      ), task AS (
        INSERT INTO media_records(account_id,namespace,id,data)
        SELECT account_id,'history',$2,$6::jsonb FROM reserve_ledger RETURNING account_id
      ), journal AS (
        INSERT INTO media_records(account_id,namespace,id,data)
        SELECT account_id,'generation-journal',$7,$8::jsonb FROM task RETURNING id
      ) SELECT id FROM journal`,
      [this.accountId, id, amount, record.nativeQuote.version,
        require('node:crypto').randomUUID(), JSON.stringify(record), item.id, JSON.stringify(item)]);
      if (!result.rowCount) throw new Error('Недостаточно кредитов на счёте');
    } else {
      await this.pool.query(`WITH task AS (
        INSERT INTO media_records(account_id,namespace,id,data)
        VALUES($1,'history',$2,$3::jsonb) RETURNING account_id
      ) INSERT INTO media_records(account_id,namespace,id,data)
        SELECT account_id,'generation-journal',$4,$5::jsonb FROM task`,
      [this.accountId, id, JSON.stringify(record), item.id, JSON.stringify(item)]);
    }
    return record;
  }
  async list() {
    return (await this.pool.query('SELECT data FROM media_records WHERE account_id=$1 AND namespace=$2 ORDER BY updated_at DESC,id', [this.accountId, this.namespace])).rows.map(row => row.data);
  }
  async get(id) {
    return (await this.pool.query('SELECT data FROM media_records WHERE account_id=$1 AND namespace=$2 AND id=$3',
      [this.accountId, this.namespace, id])).rows[0]?.data || null;
  }
  async getMany(ids) {
    const rows = (await this.pool.query('SELECT id,data FROM media_records WHERE account_id=$1 AND namespace=$2 AND id=ANY($3::text[])',
      [this.accountId, this.namespace, ids])).rows;
    return new Map(rows.map(row => [row.id, row.data]));
  }
  async listByStates(states) {
    return (await this.pool.query("SELECT data FROM media_records WHERE account_id=$1 AND namespace=$2 AND data->>'state'=ANY($3::text[]) ORDER BY updated_at DESC,id",
      [this.accountId, this.namespace, states])).rows.map(row => row.data);
  }
  async listNeedingSave() {
    return (await this.pool.query(`SELECT data FROM media_records WHERE account_id=$1 AND namespace='history'
      AND data->>'state'='success' AND data->>'resultSavedAt' IS NULL
      AND (data->>'resultJson' LIKE '%https:%' OR data->>'resultJson' LIKE '%http:%')`, [this.accountId])).rows.map(row => row.data);
  }
  async findByRequestId(requestId) {
    return (await this.pool.query("SELECT data FROM media_records WHERE account_id=$1 AND namespace=$2 AND data->>'requestId'=$3 LIMIT 1",
      [this.accountId, this.namespace, requestId])).rows[0]?.data || null;
  }
  async listSince(since, before, activeIds = []) {
    return (await this.pool.query(`SELECT data FROM media_records
      WHERE account_id=$1 AND namespace=$2 AND ((updated_at>$3::timestamptz AND updated_at<=$4::timestamptz) OR id=ANY($5::text[]))
      ORDER BY updated_at DESC,id`, [this.accountId, this.namespace, since, before, activeIds])).rows.map(row => row.data);
  }
  async update(id, changes, expectedStates) {
    const accepting = this.namespace === 'history' && changes.state === 'queued';
    const measured = async (stage, action) => {
      if (!accepting) return action();
      const started = Date.now();
      try { return await action(); }
      finally { trace.timing('generation.db_stage', { stage, elapsedMs: Date.now() - started,
        poolWaiting: this.pool.waitingCount ?? null }); }
    };
    return transaction(this.pool, async client => {
      // Only history updates can reserve or settle credits. Keep their lock order.
      const needsWallet = this.namespace === 'history' && (
        ['queued', 'success', 'fail', 'cancelled', 'blocked', 'provider_charged', 'provider_free'].includes(changes.state)
        || Object.hasOwn(changes, 'creditsConsumed') || !Object.hasOwn(changes, 'state'));
      const wallet = needsWallet ? await measured('wallet_lock', () => lockWallet(client, this.accountId)) : null;
      const old = (await measured('record_lock', () => client.query('SELECT data FROM media_records WHERE account_id=$1 AND namespace=$2 AND id=$3 FOR UPDATE', [this.accountId, this.namespace, id]))).rows[0]?.data;
      if (!old && this.namespace === 'history') {
        const deleted = (await measured('deleted_record_check', () => client.query('SELECT 1 FROM media_deleted_chat_records WHERE account_id=$1 AND namespace=$2 AND id=$3', [this.accountId, this.namespace, id]))).rows[0];
        if (deleted) throw new Error('Удалённый чат недоступен для обновления задачи');
      }
      if (expectedStates && !expectedStates.includes(old?.state)) throw new Error('Состояние задачи уже изменилось');
      const record = { ...(old || { id }), ...changes, revision: Number(old?.revision || 0) + 1, updatedAt: new Date().toISOString() };
      if (this.namespace === 'history') {
        if (!old && record.nativeQuote?.amountUnits) await measured('reserve', () => reserve(client, this.accountId, id, record.nativeQuote, wallet));
        const reportedCost = record.creditsConsumed;
        const consumed = Number(reportedCost);
        const costKnown = (typeof reportedCost === 'number' || (typeof reportedCost === 'string' && reportedCost.trim() !== ''))
          && Number.isFinite(consumed) && consumed >= 0;
        const terminal = ['success', 'fail'].includes(record.state);
        const providerCharged = Boolean(terminal && record.taskId && costKnown && consumed > 0);
        if (providerCharged && record.nativeQuote?.amountUnits && !record.providerChargeConfirmedAt) record.providerChargeConfirmedAt = new Date().toISOString();
        if (terminal && record.taskId && costKnown && consumed === 0 && !record.providerChargeConfirmedAt)
          record.providerFreeConfirmedAt = record.providerFreeConfirmedAt || new Date().toISOString();
        const settlementState = providerCharged ? 'provider_charged'
          : terminal && record.taskId && costKnown && consumed === 0 ? 'provider_free' : record.state;
        await settle(client, this.accountId, id, settlementState, record);
        await journalKieSubmission(client, this.accountId, old, record);
        if (!old || old.state !== record.state) {
          await measured('journal', () => appendGenerationEvent(client, this.accountId, 'kie', record, !old ? 'created' : record.state,
            { providerTaskId: record.taskId, error: record.error }));
        }
      }
      await measured('record_write', () => client.query('INSERT INTO media_records(account_id,namespace,id,data) VALUES($1,$2,$3,$4) ON CONFLICT(account_id,namespace,id) DO UPDATE SET data=EXCLUDED.data,updated_at=now()', [this.accountId, this.namespace, id, JSON.stringify(record)]));
      return record;
    });
  }
  async remove(id, settlementState = 'cancelled', expectedStates) {
    return transaction(this.pool, async client => {
      if (this.namespace === 'history') await lockWallet(client, this.accountId);
      const old = (await client.query('SELECT data FROM media_records WHERE account_id=$1 AND namespace=$2 AND id=$3 FOR UPDATE', [this.accountId, this.namespace, id])).rows[0]?.data;
      if (!old) return null;
      if (expectedStates && !expectedStates.includes(old.state)) return null;
      if (this.namespace === 'history' && (!['queued', 'preparing', 'blocked'].includes(old.state) || old.taskId || old.providerAcceptedAt)) return null;
      if (this.namespace === 'history') await settle(client, this.accountId, id, settlementState, old);
      if (this.namespace === 'history' && old.state === 'submitting') {
        await client.query(`UPDATE media_kie_submissions SET outcome='unknown',finished_at=now(),error_code='RECORD_REMOVED_DURING_SUBMIT'
          WHERE id=(SELECT id FROM media_kie_submissions WHERE account_id=$1 AND job_id=$2 AND outcome='pending' ORDER BY id DESC LIMIT 1)`, [this.accountId,id]);
        trace.run(old, () => trace.write('kie.submit.unknown', { reason: 'record-removed-during-submit', accountId: this.accountId, chatId: old.chatId, kieAccountId: old.kieAccountId }));
      }
      if (this.namespace === 'history') {
        await appendGenerationEvent(client, this.accountId, 'kie', old, 'removed', { providerTaskId: old.taskId });
      }
      await client.query('DELETE FROM media_records WHERE account_id=$1 AND namespace=$2 AND id=$3', [this.accountId, this.namespace, id]);
      return old;
    });
  }
}
module.exports = { AccountRecords };
