const { createHash } = require('node:crypto');

const CURRENCIES = new Set(['RUB']);
const PAYMENT_STATES = new Set(['created', 'pending', 'succeeded', 'canceled', 'failed']);

function paymentError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function text(value, name, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw paymentError('INVALID_REQUEST', `Некорректное поле ${name}`);
  return value.trim();
}

function money(value, name = 'amountMinor') {
  if (!Number.isSafeInteger(value) || value <= 0) throw paymentError('INVALID_REQUEST', `Некорректное поле ${name}`);
  return value;
}

function currency(value) {
  const normalized = String(value || '').toUpperCase();
  if (!CURRENCIES.has(normalized)) throw paymentError('INVALID_REQUEST', 'Валюта не поддерживается');
  return normalized;
}

function normalizeCreate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw paymentError('INVALID_REQUEST', 'Некорректный запрос платежа');
  return {
    externalOrderId: text(input.externalOrderId, 'externalOrderId', 100),
    amountMinor: money(input.amountMinor), currency: currency(input.currency),
    idempotencyKey: text(input.idempotencyKey, 'idempotencyKey', 100),
    description: text(input.description, 'description', 128),
    returnUrl: text(input.returnUrl, 'returnUrl', 1000),
    paymentMethod: input.paymentMethod == null ? null : text(input.paymentMethod, 'paymentMethod', 40),
    receipt: input.receipt == null ? null : input.receipt,
  };
}

function normalizeContext(ctx) {
  if (!ctx || typeof ctx !== 'object') throw paymentError('FORBIDDEN', 'Контекст клиента отсутствует', 403);
  const environment = text(ctx.environment, 'environment', 20);
  if (!['test', 'live'].includes(environment)) throw paymentError('FORBIDDEN', 'Среда платежей не поддерживается', 403);
  return { clientId: text(ctx.clientId, 'clientId', 60), environment };
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function payloadHash(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }

function assertTransition(previous, next) {
  if (!PAYMENT_STATES.has(previous) || !PAYMENT_STATES.has(next)) throw paymentError('INVALID_REQUEST', 'Неизвестное состояние платежа');
  if (previous === next) return;
  if (previous === 'succeeded') throw paymentError('INVALID_REQUEST', 'Успешный платеж нельзя отменить поздним событием');
  if (['canceled', 'failed'].includes(previous)) throw paymentError('INVALID_REQUEST', 'Терминальный платеж нельзя изменить');
  if (!['pending', 'succeeded', 'canceled', 'failed'].includes(next)) throw paymentError('INVALID_REQUEST', 'Недопустимый переход платежа');
}

function publicPayment(row) {
  return {
    schemaVersion: 1, paymentId: row.id, externalOrderId: row.external_order_id,
    amountMinor: Number(row.amount_minor), currency: row.currency, status: row.status,
    resolution: row.resolution, confirmationUrl: row.confirmation_url || null,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    refundedMinor: Number(row.refunded_minor || 0), revision: Number(row.revision),
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
  };
}

module.exports = { normalizeCreate, normalizeContext, money, currency, payloadHash, assertTransition, publicPayment, paymentError };
