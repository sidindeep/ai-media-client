async function operationsMetrics(pool) {
  const [reservations, unknown, content, payments] = await Promise.all([
    pool.query(`SELECT count(*)::int AS held, COALESCE(EXTRACT(EPOCH FROM now()-min(created_at)),0)::int AS oldest_held_seconds
      FROM media_reservations WHERE state='held'`),
    pool.query(`SELECT count(*)::int AS unknown, COALESCE(EXTRACT(EPOCH FROM now()-min(updated_at)),0)::int AS oldest_unknown_seconds
      FROM media_records WHERE namespace='history' AND data->>'state' IN ('unknown','unconfirmed')`),
    pool.query(`SELECT count(*) FILTER (WHERE state IN ('pending','retry','processing'))::int AS backlog,
      count(*) FILTER (WHERE state='failed')::int AS failed FROM content_jobs`),
    pool.query(`SELECT (SELECT count(*)::int FROM payment_outbox WHERE delivered_at IS NULL) AS outbox_backlog,
      (SELECT count(*)::int FROM payment_webhook_inbox WHERE processed_at IS NULL) AS webhook_backlog,
      (SELECT count(*)::int FROM payment_payments WHERE resolution='unknown') AS unknown_payments,
      (SELECT COALESCE(EXTRACT(EPOCH FROM now()-min(updated_at)),0)::int FROM payment_payments WHERE resolution='unknown') AS oldest_unknown_seconds,
      (SELECT count(*)::int FROM payment_commands c JOIN payment_payments p ON p.id=c.payment_id
        WHERE c.operation='create' AND p.resolution='unknown' AND c.created_at < now()-interval '23 hours') AS expired_unknown_commands,
      (SELECT COALESCE(EXTRACT(EPOCH FROM now()-min(created_at)),0)::int FROM payment_outbox WHERE delivered_at IS NULL) AS oldest_outbox_seconds`),
  ]);
  return { reservations: reservations.rows[0], generation: unknown.rows[0], content: content.rows[0], payments: payments.rows[0] };
}

module.exports = { operationsMetrics };
