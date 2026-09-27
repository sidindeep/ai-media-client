async function operationsMetrics(pool) {
  const [reservations, unknown, content, payments] = await Promise.all([
    pool.query(`SELECT count(*)::int AS held, COALESCE(EXTRACT(EPOCH FROM now()-min(created_at)),0)::int AS oldest_held_seconds
      FROM media_reservations WHERE state='held'`),
    pool.query(`SELECT count(*)::int AS unknown, COALESCE(EXTRACT(EPOCH FROM now()-min(updated_at)),0)::int AS oldest_unknown_seconds
      FROM media_records WHERE namespace='history' AND data->>'state' IN ('unknown','unconfirmed')`),
    pool.query(`SELECT count(*) FILTER (WHERE state IN ('pending','retry','processing'))::int AS backlog,
      count(*) FILTER (WHERE state='failed')::int AS failed,
      COALESCE(EXTRACT(EPOCH FROM now()-min(created_at) FILTER (WHERE state IN ('pending','retry','processing'))),0)::int AS oldest_backlog_seconds
      FROM content_jobs`),
    pool.query(`SELECT (SELECT count(*)::int FROM payment_outbox WHERE delivered_at IS NULL) AS outbox_backlog,
      (SELECT count(*)::int FROM payment_webhook_inbox WHERE processed_at IS NULL) AS webhook_backlog,
      (SELECT COALESCE(EXTRACT(EPOCH FROM now()-min(created_at)),0)::int FROM payment_webhook_inbox WHERE processed_at IS NULL) AS oldest_webhook_seconds,
      (SELECT count(*)::int FROM payment_payments WHERE resolution='unknown') AS unknown_payments,
      (SELECT COALESCE(EXTRACT(EPOCH FROM now()-min(updated_at)),0)::int FROM payment_payments WHERE resolution='unknown') AS oldest_unknown_seconds,
      (SELECT count(*)::int FROM payment_commands c JOIN payment_payments p ON p.id=c.payment_id
        WHERE c.operation='create' AND p.resolution='unknown' AND c.created_at < now()-interval '23 hours') AS expired_unknown_commands,
      (SELECT COALESCE(EXTRACT(EPOCH FROM now()-min(created_at)),0)::int FROM payment_outbox WHERE delivered_at IS NULL) AS oldest_outbox_seconds`),
  ]);
  const result = { reservations: reservations.rows[0], generation: unknown.rows[0], content: content.rows[0], payments: payments.rows[0] };
  result.alerts = operationsAlerts(result);
  return result;
}

function operationsAlerts(metrics) {
  const alerts = [];
  const add = (condition, code, severity) => { if (condition) alerts.push({ code, severity }); };
  add(metrics.reservations.oldest_held_seconds >= 3600, 'HELD_RESERVATION_OLD', 'warning');
  add(metrics.generation.oldest_unknown_seconds >= 1800, 'GENERATION_UNKNOWN_OLD', 'warning');
  add(metrics.content.failed > 0, 'CONTENT_SAVE_FAILED', 'warning');
  add(metrics.content.oldest_backlog_seconds >= 900, 'CONTENT_BACKLOG_OLD', 'warning');
  add(metrics.payments.oldest_outbox_seconds >= 300, 'PAYMENT_OUTBOX_OLD', 'critical');
  add(metrics.payments.oldest_webhook_seconds >= 300, 'PAYMENT_WEBHOOK_OLD', 'critical');
  add(metrics.payments.oldest_unknown_seconds >= 900, 'PAYMENT_UNKNOWN_OLD', 'critical');
  add(metrics.payments.expired_unknown_commands > 0, 'PAYMENT_COMMAND_REVIEW', 'critical');
  return alerts;
}

module.exports = { operationsMetrics, operationsAlerts };
