const systemErrors = require('../system-errors');
const { randomUUID } = require('node:crypto');
const { transaction } = require('../database/database');
const { normalizeCreate, normalizeContext, payloadHash, assertTransition, publicPayment, paymentError } = require('./contracts');

function createPayments({ pool, provider, onEvent }) {
  if (!pool || !provider) throw new Error('Payments requires pool and provider');
  const select = async (executor, ctx, id, byOrder = false, lock = false) => (await executor.query(
    `SELECT * FROM payment_payments WHERE client_id=$1 AND environment=$2 AND ${byOrder ? 'external_order_id' : 'id'}=$3${lock ? ' FOR UPDATE' : ''}`,
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
      const row = await select(client, ctx, paymentId, false, true);
      if (!row) throw paymentError('NOT_FOUND', 'Платеж не найден', 404);
      if (result.amountMinor != null && (result.amountMinor !== Number(row.amount_minor) || result.currency !== row.currency)) throw paymentError('PROVIDER_UNAVAILABLE', 'Сумма платежа у провайдера не совпадает', 502);
      if (['succeeded', 'canceled', 'failed'].includes(row.status) && row.status !== result.status) return publicPayment(row);
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
    const token = randomUUID();
    const rows = (await pool.query(`WITH ready AS (
      SELECT event_id FROM payment_outbox WHERE delivered_at IS NULL AND next_attempt_at<=now()
        AND (leased_until IS NULL OR leased_until<=now())
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $1
    ) UPDATE payment_outbox o SET lease_token=$2,leased_until=now()+interval '30 seconds'
      FROM ready WHERE o.event_id=ready.event_id RETURNING o.*`, [limit, token])).rows;
    for (const row of rows) {
      try { await onEvent?.(row.payload); await pool.query(`UPDATE payment_outbox SET delivered_at=now(),attempts=attempts+1,
        lease_token=NULL,leased_until=NULL WHERE event_id=$1 AND lease_token=$2 AND leased_until>now() AND delivered_at IS NULL`, [row.event_id, token]); }
      catch (error) { systemErrors.record('payments', 'operation.error', error); await pool.query(`UPDATE payment_outbox SET attempts=attempts+1,last_error=$3,
        next_attempt_at=now()+interval '5 seconds',lease_token=NULL,leased_until=NULL WHERE event_id=$1 AND lease_token=$2`,
      [row.event_id, token, String(error?.code || error?.message || 'DELIVERY_FAILED').slice(0, 200)]); }
    }
  }

  async function drainWebhooks(limit = 20) {
    const pending = (await pool.query(`SELECT event_identity,payload FROM payment_webhook_inbox
      WHERE provider_id=$1 AND provider_account_id=$2 AND environment=$3 AND processed_at IS NULL
      ORDER BY created_at LIMIT $4`, [provider.id, provider.accountId, provider.environment, limit])).rows;
    for (const event of pending) {
      const result = event.payload;
      const attempt = (await pool.query(`SELECT a.payment_id,p.client_id,p.environment FROM payment_attempts a
        JOIN payment_payments p ON p.id=a.payment_id WHERE a.provider_id=$1 AND a.provider_account_id=$2
        AND a.environment=$3 AND a.provider_payment_id=$4`,
      [provider.id, provider.accountId, provider.environment, result.providerPaymentId])).rows[0];
      if (!attempt) continue;
      await applyProviderResult({ clientId: attempt.client_id, environment: attempt.environment }, attempt.payment_id, result);
      await pool.query(`UPDATE payment_webhook_inbox SET processed_at=now() WHERE provider_id=$1 AND provider_account_id=$2
        AND environment=$3 AND event_identity=$4 AND processed_at IS NULL`, [provider.id, provider.accountId, provider.environment, event.event_identity]);
    }
    await deliver();
  }

  async function recoverCommands(limit = 10) {
    const token = randomUUID();
    const rows = await transaction(pool, async client => {
      const ready = (await client.query(`SELECT c.id,c.payment_id,c.client_id,c.environment,c.idempotency_key,c.request_payload
        FROM payment_commands c JOIN payment_payments p ON p.id=c.payment_id
        WHERE c.operation='create' AND c.request_payload IS NOT NULL
          AND c.created_at<now()-interval '30 seconds' AND c.created_at>now()-interval '23 hours'
          AND c.next_attempt_at<=now() AND (c.leased_until IS NULL OR c.leased_until<now())
          AND (p.status='created' OR p.resolution='unknown')
        ORDER BY c.created_at FOR UPDATE OF c SKIP LOCKED LIMIT $1`, [limit])).rows;
      for (const row of ready) await client.query(`UPDATE payment_commands SET lease_token=$2,leased_until=now()+interval '2 minutes'
        WHERE id=$1`, [row.id, token]);
      return ready;
    });
    for (const row of rows) {
      try {
        const ctx = { clientId: row.client_id, environment: row.environment };
        const result = await provider.createPayment({ ...row.request_payload, ...ctx, idempotencyKey: row.idempotency_key });
        await applyProviderResult(ctx, row.payment_id, result);
        await drainWebhooks();
        await pool.query('UPDATE payment_commands SET lease_token=NULL,leased_until=NULL WHERE id=$1 AND lease_token=$2', [row.id, token]);
      } catch (error) { systemErrors.record('payments', 'operation.error', error);
        await pool.query(`UPDATE payment_commands SET lease_token=NULL,leased_until=NULL,next_attempt_at=now()+interval '5 minutes'
          WHERE id=$1 AND lease_token=$2`, [row.id, token]);
        console.error('Payment command recovery failed:', error);
      }
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
        await client.query(`INSERT INTO payment_commands(id,operation,client_id,environment,idempotency_key,payload_hash,payment_id,request_payload)
          VALUES($1,'create',$2,$3,$4,$5,$6,$7)`, [randomUUID(), ctx.clientId, ctx.environment, input.idempotencyKey, hash, id, input]);
        await client.query(`INSERT INTO payment_attempts(id,payment_id,provider_id,provider_account_id,environment,provider_idempotency_key,state,resolution)
          VALUES($1,$2,$3,$4,$5,$6,'created','known')`, [randomUUID(), id, provider.id, provider.accountId, ctx.environment, input.idempotencyKey]);
        return inserted;
      }); } catch (error) { systemErrors.record('payments', 'operation.error', error);
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
      catch (error) { systemErrors.record('payments', 'operation.error', error);
        await pool.query(`UPDATE payment_payments SET resolution=$2,updated_at=now() WHERE id=$1`, [row.id, error.outcome === 'not_sent' ? 'known' : 'unknown']);
        throw Object.assign(error, { code: error.code || (error.outcome === 'not_sent' ? 'PROVIDER_UNAVAILABLE' : 'OPERATION_UNCERTAIN'), status: error.status || 502 });
      }
      const payment = await applyProviderResult(ctx, row.id, result); await drainWebhooks(); return payment;
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
      if (!result?.providerPaymentId || !['pending', 'succeeded', 'canceled', 'failed'].includes(result.status)) throw paymentError('INVALID_REQUEST', 'Некорректное уведомление провайдера');
      const payload = { providerPaymentId: result.providerPaymentId, status: result.status, resolution: result.resolution || 'known',
        amountMinor: result.amountMinor, currency: result.currency, confirmationUrl: result.confirmationUrl || null, expiresAt: result.expiresAt || null };
      const identity = `${payload.providerPaymentId}:${payload.status}`;
      await pool.query(`INSERT INTO payment_webhook_inbox(provider_id,provider_account_id,environment,event_identity,payload_hash,payload)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [provider.id, provider.accountId, provider.environment, identity, payloadHash(payload), payload]);
      await drainWebhooks();
      return { accepted: true };
    },
    deliver,
    drainWebhooks,
    recoverCommands,
  };
}
module.exports = { createPayments };
