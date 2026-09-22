const { randomUUID } = require('node:crypto');
const { transaction } = require('../database/database');
const { units, SCALE } = require('./pricing');
async function lockWallet(client, accountId) {
  const row = (await client.query('SELECT * FROM media_wallets WHERE account_id=$1 FOR UPDATE', [accountId])).rows[0];
  if (!row) throw new Error('Счёт не найден');
  return { balance: Number(row.balance), held: Number(row.held) };
}
async function entry(client, accountId, kind, reference, amount, actor = null, note = '') {
  await client.query('INSERT INTO media_ledger(id,account_id,kind,reference,amount,actor_id,note) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [randomUUID(), accountId, kind, reference, amount, actor, note]);
}
async function reserve(client, accountId, jobId, quote) {
  const amount = units(quote.amountUnits);
  if (!amount) throw new Error('Цена не опубликована');
  const wallet = await lockWallet(client, accountId);
  if (wallet.balance - wallet.held < amount) throw new Error('Недостаточно кредитов на счёте');
  await client.query('UPDATE media_wallets SET held=held+$2 WHERE account_id=$1', [accountId, amount]);
  await client.query("INSERT INTO media_reservations(job_id,account_id,amount,price_version,state) VALUES($1,$2,$3,$4,'held')", [jobId, accountId, amount, quote.version]);
  await entry(client, accountId, 'reserve', jobId, amount);
}
// Called in the SAME transaction that persists the terminal job state.
async function settle(client, accountId, jobId, state) {
  if (!['success', 'fail', 'cancelled', 'blocked'].includes(state)) return;
  await lockWallet(client, accountId);
  const reservation = (await client.query('SELECT * FROM media_reservations WHERE job_id=$1 AND account_id=$2 FOR UPDATE', [jobId, accountId])).rows[0];
  if (!reservation || reservation.state !== 'held') return;
  const captured = state === 'success';
  await client.query('UPDATE media_wallets SET held=held-$2,balance=balance-$3 WHERE account_id=$1', [accountId, reservation.amount, captured ? reservation.amount : 0]);
  await client.query('UPDATE media_reservations SET state=$2 WHERE job_id=$1', [jobId, captured ? 'captured' : 'released']);
  await entry(client, accountId, captured ? 'capture' : 'release', jobId, reservation.amount);
}
function createWallet(pool, { onPurchase } = {}) {
  return {
    async get(accountId) {
      const row = (await pool.query('SELECT balance,held FROM media_wallets WHERE account_id=$1', [accountId])).rows[0];
      if (!row) throw new Error('Счёт не найден');
      return { balanceUnits: Number(row.balance), heldUnits: Number(row.held), balance: (Number(row.balance) - Number(row.held)) / SCALE, currency: 'credits', scale: SCALE };
    },
    async ledger(accountId) {
      return (await pool.query('SELECT kind,reference,amount,created_at FROM media_ledger WHERE account_id=$1 ORDER BY created_at DESC LIMIT 200', [accountId])).rows;
    },
    async grant(actorId, accountId, amount, reference, note) {
      units(amount);
      if (!amount || typeof reference !== 'string' || !/^[\w-]{8,100}$/.test(reference) || typeof note !== 'string' || !note.trim() || note.length > 500) throw new Error('Укажите сумму, идентификатор и причину начисления');
      return transaction(pool, async client => {
        if ((await client.query('SELECT role FROM media_accounts WHERE id=$1', [actorId])).rows[0]?.role !== 'admin') throw new Error('Доступ запрещён');
        const wallet = await lockWallet(client, accountId);
        const previous = (await client.query("SELECT amount,note FROM media_ledger WHERE account_id=$1 AND kind='grant' AND reference=$2", [accountId, reference])).rows[0];
        if (previous) {
          if (Number(previous.amount) !== amount || previous.note !== note) throw new Error('Начисление с этим идентификатором уже отличается');
          return;
        }
        units(wallet.balance + amount);
        await client.query('UPDATE media_wallets SET balance=balance+$2 WHERE account_id=$1', [accountId, amount]);
        await entry(client, accountId, 'grant', reference, amount, actorId, note);
      });
    },
    async purchase(accountId, amount, reference, note = 'Оплата кредитов') {
      const created = await transaction(pool, client => purchaseInTransaction(client, accountId, amount, reference, note));
      if (created) await onPurchase?.(accountId);
      return created;
    }
  };
}
async function purchaseInTransaction(client, accountId, amount, reference, note = 'Оплата кредитов') {
  units(amount);
  if (!amount || typeof reference !== 'string' || !/^[\w-]{8,100}$/.test(reference) || typeof note !== 'string' || !note.trim() || note.length > 500) throw new Error('Укажите сумму, идентификатор и назначение платежа');
  const wallet = await lockWallet(client, accountId);
  const previous = (await client.query("SELECT amount,note FROM media_ledger WHERE account_id=$1 AND kind='purchase' AND reference=$2", [accountId, reference])).rows[0];
  if (previous) {
    if (Number(previous.amount) !== amount || previous.note !== note) throw new Error('Платёж с этим идентификатором уже отличается');
    return false;
  }
  units(wallet.balance + amount);
  await client.query('UPDATE media_wallets SET balance=balance+$2 WHERE account_id=$1', [accountId, amount]);
  await entry(client, accountId, 'purchase', reference, amount, null, note);
  return true;
}
module.exports = { createWallet, reserve, settle, lockWallet, purchaseInTransaction };
