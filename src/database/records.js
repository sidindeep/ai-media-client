const { transaction } = require('./database');
const { reserve, settle, lockWallet } = require('../billing/wallet');
const trace = require('../generation-log');
const { appendGenerationEvent } = require('../services/generation-journal');
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
  async list() {
    return (await this.pool.query('SELECT data FROM media_records WHERE account_id=$1 AND namespace=$2 ORDER BY updated_at DESC,id', [this.accountId, this.namespace])).rows.map(row => row.data);
  }
  async listSince(since, before, activeIds = []) {
    return (await this.pool.query(`SELECT data FROM media_records
      WHERE account_id=$1 AND namespace=$2 AND ((updated_at>$3::timestamptz AND updated_at<=$4::timestamptz) OR id=ANY($5::text[]))
      ORDER BY updated_at DESC,id`, [this.accountId, this.namespace, since, before, activeIds])).rows.map(row => row.data);
  }
  async update(id, changes, expectedStates) {
    return transaction(this.pool, async client => {
      // Consistent wallet -> record lock ordering also serializes first inserts.
      await lockWallet(client, this.accountId);
      const old = (await client.query('SELECT data FROM media_records WHERE account_id=$1 AND namespace=$2 AND id=$3 FOR UPDATE', [this.accountId, this.namespace, id])).rows[0]?.data;
      if (expectedStates && !expectedStates.includes(old?.state)) throw new Error('Состояние задачи уже изменилось');
      const record = { ...(old || { id }), ...changes, revision: Number(old?.revision || 0) + 1, updatedAt: new Date().toISOString() };
      if (this.namespace === 'history') {
        if (!old && record.nativeQuote?.amountUnits) await reserve(client, this.accountId, id, record.nativeQuote);
        await settle(client, this.accountId, id, record.state, record);
        await journalKieSubmission(client, this.accountId, old, record);
        if (!old || old.state !== record.state) {
          await appendGenerationEvent(client, this.accountId, 'kie', record, !old ? 'created' : record.state,
            { providerTaskId: record.taskId, error: record.error });
        }
      }
      await client.query('INSERT INTO media_records(account_id,namespace,id,data) VALUES($1,$2,$3,$4) ON CONFLICT(account_id,namespace,id) DO UPDATE SET data=EXCLUDED.data,updated_at=now()', [this.accountId, this.namespace, id, JSON.stringify(record)]);
      return record;
    });
  }
  async remove(id, settlementState = 'cancelled', expectedStates) {
    return transaction(this.pool, async client => {
      await lockWallet(client, this.accountId);
      const old = (await client.query('SELECT data FROM media_records WHERE account_id=$1 AND namespace=$2 AND id=$3 FOR UPDATE', [this.accountId, this.namespace, id])).rows[0]?.data;
      if (!old) return null;
      if (expectedStates && !expectedStates.includes(old.state)) return null;
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
