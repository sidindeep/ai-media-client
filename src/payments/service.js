const { randomUUID } = require('node:crypto');
const { transaction } = require('../database/database');
const { normalizeCreate, normalizeContext, payloadHash, assertTransition, publicPayment, paymentError } = require('./contracts');

function createPayments({ pool, provider, onEvent }) {
  if (!pool || !provider) throw new Error('Payments requires pool and provider');
  const select = async (executor, ctx, id, byOrder = false) => (await executor.query(
    `SELECT * FROM payment_payments WHERE client_id=$1 AND environment=$2 AND ${byOrder ? 'external_order_id' : 'id'}=$3`,
    [ctx.clientId, ctx.environment, id])).rows[0];

  async function emit(client, row, type) {
    if (!type) return;
    const eventId = randomUUID();
    const payload = { schemaVersion: 1, eventId, type, occurredAt: new Date().toISOString(), clientId: row.client_id,
      environment: row.environment, paymentId: row.id, externalOrderId: row.external_order_id, revision: Number(row.revision),
      amountMinor: Number(row.amount_minor), currency: row.currency };
    await client.query(`INSERT INTO payment_outbox(event_id,client_id,environment,aggregate_id,revision,type,payload)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(event_id) DO NOTHING`, [eventId, row.client_id, row.environment, row.id, row.revision, type, payload]);
  }

  async function applyProviderResult(ctx, paymentId, result) {
    return transaction(pool, async client => {
      const row = await select(client, ctx, paymentId);
      if (!row) throw paymentError('NOT_FOUND', 'Платеж не найден', 404);
      if (result.amountMinor != null && (result.amountMinor !== Number(row.amount_minor) || result.currency !== row.currency)) throw paymentError('PROVIDER_UNAVAILABLE', 'Сумма платежа у провайдера не совпадает', 502);
      assertTransition(row.status, result.status);
      const changed = row.status !== result.status;
      const next = (await client.query(`UPDATE payment_payments SET status=$2,resolution=$3,confirmation_url=$4,expires_at=$5,
        revision=revision+$6,updated_at=now() WHERE id=$1 RETURNING *`, [row.id, result.status, result.resolution || 'known', result.confirmationUrl || null, result.expiresAt || null, changed ? 1 : 0])).rows[0];
      await client.query(`UPDATE payment_attempts SET provider_payment_id=COALESCE(provider_payment_id,$2),state=$3,resolution=$4,updated_at=now()
        WHERE payment_id=$1`, [row.id, result.providerPaymentId || null, result.status, result.resolution || 'known']);
      if (changed && ['succeeded', 'canceled', 'failed'].includes(result.status)) await emit(client, next, `payment.${result.status}`);
      return publicPayment(next);
    });
  }
  function assertSamePayment(row, input) {
    if (Number(row.amount_minor) !== input.amountMinor || row.currency !== input.currency) throw paymentError('IDEMPOTENCY_CONFLICT', 'Заказ уже связан с другой суммой или валютой', 409);
    return row;
  }

  async function deliver(limit = 20) {
    const rows = (await pool.query(`SELECT * FROM payment_outbox WHERE delivered_at IS NULL AND next_attempt_at<=now()
      ORDER BY created_at LIMIT $1`, [limit])).rows;
    for (const row of rows) {
      try { await onEvent?.(row.payload); await pool.query('UPDATE payment_outbox SET delivered_at=now(),attempts=attempts+1 WHERE event_id=$1 AND delivered_at IS NULL', [row.event_id]); }
      catch (error) { await pool.query(`UPDATE payment_outbox SET attempts=attempts+1,last_error=$2,next_attempt_at=now()+interval '5 seconds' WHERE event_id=$1`, [row.event_id, String(error?.code || error?.message || 'DELIVERY_FAILED').slice(0, 200)]); }
    }
  }

  return {
    capabilities(ctx) { normalizeContext(ctx); return provider.capabilities(); },
    async createPayment(rawCtx, rawInput) {
      const ctx = normalizeContext(rawCtx), input = normalizeCreate(rawInput), hash = payloadHash(input);
      if (ctx.environment !== provider.environment) throw paymentError('FORBIDDEN', 'Среда провайдера не совпадает', 403);
      let created = false;
      let row;
      try { row = await transaction(pool, async client => {
        const command = (await client.query(`SELECT payload_hash,payment_id FROM payment_commands
          WHERE client_id=$1 AND environment=$2 AND operation='create' AND idempotency_key=$3 FOR UPDATE`, [ctx.clientId, ctx.environment, input.idempotencyKey])).rows[0];
        if (command) {
          if (command.payload_hash !== hash) throw paymentError('IDEMPOTENCY_CONFLICT', 'Ключ уже использован с другим запросом', 409);
          return select(client, ctx, command.payment_id);
        }
        const existing = await select(client, ctx, input.externalOrderId, true);
        if (existing) return assertSamePayment(existing, input);
        const id = randomUUID(); created = true;
        const inserted = (await client.query(`INSERT INTO payment_payments(id,client_id,environment,external_order_id,amount_minor,currency,status,resolution)
          VALUES($1,$2,$3,$4,$5,$6,'created','known') RETURNING *`, [id, ctx.clientId, ctx.environment, input.externalOrderId, input.amountMinor, input.currency])).rows[0];
        await client.query(`INSERT INTO payment_commands(id,operation,client_id,environment,idempotency_key,payload_hash,payment_id)
          VALUES($1,'create',$2,$3,$4,$5,$6)`, [randomUUID(), ctx.clientId, ctx.environment, input.idempotencyKey, hash, id]);
        await client.query(`INSERT INTO payment_attempts(id,payment_id,provider_id,provider_account_id,environment,provider_idempotency_key,state,resolution)
          VALUES($1,$2,$3,$4,$5,$6,'created','known')`, [randomUUID(), id, provider.id, provider.accountId, ctx.environment, input.idempotencyKey]);
        return inserted;
      }); } catch (error) {
        if (error.code !== '23505') throw error;
        const command = (await pool.query(`SELECT payload_hash,payment_id FROM payment_commands
          WHERE client_id=$1 AND environment=$2 AND operation='create' AND idempotency_key=$3`, [ctx.clientId, ctx.environment, input.idempotencyKey])).rows[0];
        if (command) {
          if (command.payload_hash !== hash) throw paymentError('IDEMPOTENCY_CONFLICT', 'Ключ уже использован с другим запросом', 409);
          row = await select(pool, ctx, command.payment_id);
        } else {
          row = await select(pool, ctx, input.externalOrderId, true);
          if (!row) throw error;
          assertSamePayment(row, input);
        }
        created = false;
      }
      if (!created || row.status !== 'created') return publicPayment(row);
      let result;
      try { result = await provider.createPayment({ ...input, ...ctx }); }
      catch (error) {
        await pool.query(`UPDATE payment_payments SET resolution=$2,updated_at=now() WHERE id=$1`, [row.id, error.outcome === 'not_sent' ? 'known' : 'unknown']);
        throw Object.assign(error, { code: error.code || (error.outcome === 'not_sent' ? 'PROVIDER_UNAVAILABLE' : 'OPERATION_UNCERTAIN'), status: error.status || 502 });
      }
      const payment = await applyProviderResult(ctx, row.id, result); await deliver(); return payment;
    },
    async getPayment(rawCtx, { paymentId }) { const ctx = normalizeContext(rawCtx), row = await select(pool, ctx, paymentId); if (!row) throw paymentError('NOT_FOUND', 'Платеж не найден', 404); return publicPayment(row); },
    async getPaymentByOrder(rawCtx, { externalOrderId }) { const ctx = normalizeContext(rawCtx), row = await select(pool, ctx, externalOrderId, true); if (!row) throw paymentError('NOT_FOUND', 'Платеж не найден', 404); return publicPayment(row); },
    async reconcile(rawCtx, paymentId) {
      const ctx = normalizeContext(rawCtx), attempt = (await pool.query(`SELECT a.* FROM payment_attempts a JOIN payment_payments p ON p.id=a.payment_id
        WHERE p.id=$1 AND p.client_id=$2 AND p.environment=$3`, [paymentId, ctx.clientId, ctx.environment])).rows[0];
      if (!attempt?.provider_payment_id) throw paymentError('OPERATION_UNCERTAIN', 'Идентификатор платежа у провайдера ещё неизвестен', 409);
      const payment = await applyProviderResult(ctx, paymentId, await provider.getPayment(attempt.provider_payment_id)); await deliver(); return payment;
    },
    async webhook(body) {
      const result = await provider.verifyWebhook(body);
      const attempt = (await pool.query('SELECT payment_id FROM payment_attempts WHERE provider_id=$1 AND provider_account_id=$2 AND environment=$3 AND provider_payment_id=$4',
        [provider.id, provider.accountId, provider.environment, result.providerPaymentId])).rows[0];
      if (!attempt) throw paymentError('NOT_FOUND', 'Платеж для уведомления не найден', 404);
      const row = (await pool.query('SELECT client_id,environment FROM payment_payments WHERE id=$1', [attempt.payment_id])).rows[0];
      const payment = await applyProviderResult(row, attempt.payment_id, result); await deliver(); return payment;
    },
    deliver,
  };
}
module.exports = { createPayments };
