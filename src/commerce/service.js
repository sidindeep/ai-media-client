const { randomUUID } = require('node:crypto');
const { transaction } = require('../database/database');
const { payloadHash } = require('../payments/contracts');
const { purchaseInTransaction } = require('../billing/wallet');

function orderDto(row) {
  return { id: row.id, status: row.status, offer: row.offer_snapshot, amountMinor: Number(row.amount_minor), currency: row.currency,
    creditUnits: Number(row.credit_units), paymentId: row.payment_id || null, confirmationUrl: row.confirmation_url || null,
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() };
}

function createCommerce({ pool, catalog, paymentClient, paymentContext, onPurchase }) {
  async function own(accountId, orderId, executor = pool) {
    const row = (await executor.query('SELECT * FROM media_orders WHERE id=$1 AND account_id=$2', [orderId, accountId])).rows[0];
    if (!row) throw Object.assign(new Error('Заказ не найден'), { status: 404, code: 'NOT_FOUND' });
    return row;
  }
  return {
    offers() { return catalog.list(); },
    async createOrder(accountId, input) {
      const offer = catalog.get(input?.offerId, input?.offerVersion);
      const key = typeof input?.idempotencyKey === 'string' && /^[\w-]{8,100}$/.test(input.idempotencyKey) ? input.idempotencyKey : null;
      if (!key) throw Object.assign(new Error('Некорректный ключ заказа'), { status: 400, code: 'INVALID_REQUEST' });
      const hash = payloadHash({ offerId: offer.id, offerVersion: offer.version });
      try { return await transaction(pool, async client => {
        const previous = (await client.query('SELECT * FROM media_orders WHERE account_id=$1 AND checkout_key=$2 FOR UPDATE', [accountId, key])).rows[0];
        if (previous) { if (previous.checkout_hash !== hash) throw Object.assign(new Error('Ключ заказа использован с другим предложением'), { status: 409, code: 'IDEMPOTENCY_CONFLICT' }); return orderDto(previous); }
        const row = (await client.query(`INSERT INTO media_orders(id,account_id,status,product_id,product_version,offer_snapshot,amount_minor,currency,credit_units,checkout_key,checkout_hash)
          VALUES($1,$2,'awaiting_payment',$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [randomUUID(), accountId, offer.id, offer.version, offer, offer.amountMinor, offer.currency, offer.creditUnits, key, hash])).rows[0];
        return orderDto(row);
      }); } catch (error) {
        if (error.code !== '23505') throw error;
        const previous = (await pool.query('SELECT * FROM media_orders WHERE account_id=$1 AND checkout_key=$2', [accountId, key])).rows[0];
        if (!previous || previous.checkout_hash !== hash) throw Object.assign(new Error('Ключ заказа использован с другим предложением'), { status: 409, code: 'IDEMPOTENCY_CONFLICT' });
        return orderDto(previous);
      }
    },
    async getOrder(accountId, orderId) { return orderDto(await own(accountId, orderId)); },
    async listOrders(accountId, limit = 50) { return (await pool.query('SELECT * FROM media_orders WHERE account_id=$1 ORDER BY created_at DESC LIMIT $2', [accountId, Math.max(1, Math.min(100, limit))])).rows.map(orderDto); },
    async checkout(accountId, orderId, returnUrl) {
      const row = await own(accountId, orderId);
      if (row.payment_id) return orderDto(row);
      const payment = await paymentClient.createPayment(paymentContext, { externalOrderId: row.id, amountMinor: Number(row.amount_minor), currency: row.currency,
        idempotencyKey: `order-${row.id}`, description: `AI Media Client: ${row.offer_snapshot.name}`, returnUrl });
      const updated = (await pool.query(`UPDATE media_orders SET payment_id=$3,confirmation_url=$4,status=CASE WHEN status='awaiting_payment' AND $5='succeeded' THEN 'paid_pending_fulfillment' ELSE status END,updated_at=now()
        WHERE id=$1 AND account_id=$2 AND (payment_id IS NULL OR payment_id=$3) RETURNING *`, [row.id, accountId, payment.paymentId, payment.confirmationUrl, payment.status])).rows[0];
      await paymentClient.deliver?.();
      return orderDto(updated || await own(accountId, orderId));
    },
    async handlePaymentEvent(event) {
      if (event.schemaVersion !== 1 || event.clientId !== paymentContext.clientId || event.environment !== paymentContext.environment) throw Object.assign(new Error('Неизвестный контракт события'), { code: 'EVENT_CONTRACT_INVALID' });
      if (!['payment.succeeded', 'payment.canceled', 'payment.failed'].includes(event.type)) return;
      let accountId, created = false;
      await transaction(pool, async client => {
        const duplicate = (await client.query('SELECT payload_hash FROM media_payment_inbox WHERE producer=$1 AND environment=$2 AND event_id=$3 FOR UPDATE',
          [event.clientId, event.environment, event.eventId])).rows[0];
        const hash = payloadHash(event);
        if (duplicate) { if (duplicate.payload_hash !== hash) throw Object.assign(new Error('Event ID повторён с другим содержимым'), { code: 'EVENT_CONFLICT' }); return; }
        const order = (await client.query('SELECT * FROM media_orders WHERE id=$1 FOR UPDATE', [event.externalOrderId])).rows[0];
        if (!order || (order.payment_id && order.payment_id !== event.paymentId) || Number(order.amount_minor) !== event.amountMinor || order.currency !== event.currency) throw Object.assign(new Error('Платёж не совпадает с заказом'), { code: 'PAYMENT_MISMATCH' });
        if (!order.payment_id) await client.query('UPDATE media_orders SET payment_id=$2,updated_at=now() WHERE id=$1', [order.id, event.paymentId]);
        accountId = order.account_id;
        await client.query(`INSERT INTO media_payment_inbox(producer,environment,event_id,payload_hash,order_id,payload)
          VALUES($1,$2,$3,$4,$5,$6)`, [event.clientId, event.environment, event.eventId, hash, order.id, event]);
        if (event.type === 'payment.succeeded') {
          const inserted = await client.query(`INSERT INTO media_order_fulfillments(order_id,producer,environment,payment_id,account_id,credit_units,ledger_reference)
            VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING order_id`, [order.id, event.clientId, event.environment, event.paymentId, order.account_id, order.credit_units, `payment-${event.paymentId}`]);
          if (inserted.rowCount) {
            created = await purchaseInTransaction(client, order.account_id, Number(order.credit_units), `payment-${event.paymentId}`, `Оплата заказа ${order.id}`);
            await client.query("UPDATE media_orders SET status='fulfilled',updated_at=now() WHERE id=$1", [order.id]);
          }
        } else if (order.status === 'awaiting_payment') {
          await client.query("UPDATE media_orders SET status='payment_failed',updated_at=now() WHERE id=$1", [order.id]);
        }
        await client.query('UPDATE media_payment_inbox SET processed_at=now() WHERE producer=$1 AND environment=$2 AND event_id=$3', [event.clientId, event.environment, event.eventId]);
      });
      if (created) await onPurchase?.(accountId);
    },
  };
}
module.exports = { createCommerce };
