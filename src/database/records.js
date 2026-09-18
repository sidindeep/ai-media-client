const { transaction } = require('./database');
const { reserve, settle, lockWallet } = require('../billing/wallet');
class AccountRecords {
  constructor(pool, accountId, namespace) { Object.assign(this, { pool, accountId, namespace }); }
  async list() {
    return (await this.pool.query('SELECT data FROM media_records WHERE account_id=$1 AND namespace=$2 ORDER BY updated_at DESC,id', [this.accountId, this.namespace])).rows.map(row => row.data);
  }
  async update(id, changes, expectedStates) {
    return transaction(this.pool, async client => {
      // Consistent wallet -> record lock ordering also serializes first inserts.
      await lockWallet(client, this.accountId);
      const old = (await client.query('SELECT data FROM media_records WHERE account_id=$1 AND namespace=$2 AND id=$3 FOR UPDATE', [this.accountId, this.namespace, id])).rows[0]?.data;
      if (expectedStates && !expectedStates.includes(old?.state)) throw new Error('Состояние задачи уже изменилось');
      const record = { ...(old || { id }), ...changes, updatedAt: new Date().toISOString() };
      if (this.namespace === 'history') {
        if (!old && record.nativeQuote) await reserve(client, this.accountId, id, record.nativeQuote);
        await settle(client, this.accountId, id, record.state);
      }
      await client.query('INSERT INTO media_records(account_id,namespace,id,data) VALUES($1,$2,$3,$4) ON CONFLICT(account_id,namespace,id) DO UPDATE SET data=EXCLUDED.data,updated_at=now()', [this.accountId, this.namespace, id, JSON.stringify(record)]);
      return record;
    });
  }
}
module.exports = { AccountRecords };
