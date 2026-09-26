const PERIODS = new Set([7, 30, 90]);

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function classify(row) {
  const record = row.record || {};
  const provider = row.job_id.startsWith('codex:') ? 'codex' : row.job_id.startsWith('routerai:') ? 'routerai' : 'kie';
  const capturedUnits = Number(row.captured_units || 0);
  const releasedUnits = Number(row.released_units || 0);
  const heldUnits = row.reservation_state === 'held' ? Number(row.reserved_units) : 0;
  const providerCost = provider === 'kie' ? finitePositive(record.creditsConsumed)
    : provider === 'routerai' ? finitePositive(record.providerCostRub) : 0;
  const usage = provider === 'codex' ? finitePositive(record.usage?.total_tokens) : 0;
  const providerFree = Boolean(record.providerFreeConfirmedAt)
    || (provider === 'kie' && record.state === 'success' && Number(record.creditsConsumed) === 0 && record.creditsConsumed != null)
    || (provider === 'routerai' && record.state === 'success' && Number(record.providerCostRub) === 0 && record.providerCostRub != null);
  const accepted = Boolean(row.kie_accepted || row.kie_unknown || record.taskId || record.providerAcceptedAt || record.providerVideoId
    || record.state === 'success' || providerCost > 0 || usage > 0);
  const providerEvidence = providerCost > 0;
  let risk = null;
  if (releasedUnits > 0 && capturedUnits === 0 && providerEvidence) risk = 'confirmed_mismatch';
  else if (releasedUnits > 0 && capturedUnits === 0 && accepted && !providerFree) risk = 'released_after_send';
  else if (heldUnits > 0 && ['unknown', 'unconfirmed'].includes(record.state)) risk = 'held_unknown';
  if (!risk) return null;
  return {
    risk, provider, accountId: row.account_id, accountName: row.account_name,
    jobId: row.job_id, providerTaskId: record.taskId || record.providerVideoId || row.kie_provider_task_id || null,
    model: record.modelName || record.model || record.modelId || null,
    state: record.state || null, createdAt: row.created_at,
    reservedUnits: Number(row.reserved_units), capturedUnits, releasedUnits, heldUnits,
    providerCost: providerCost || null, providerCostUnit: provider === 'kie' ? 'Kie credits' : provider === 'routerai' ? '₽' : null,
    providerUsageTokens: usage || null, accepted,
  };
}

async function billingReconciliation(pool, days = 30) {
  const period = Number(days);
  if (!PERIODS.has(period)) throw Object.assign(new Error('Некорректный период'), { status: 400 });
  const rows = (await pool.query(`SELECT r.account_id,r.job_id,r.amount AS reserved_units,r.state AS reservation_state,r.created_at,
      a.display_name AS account_name,m.data AS record,
      l.captured_units,l.released_units,s.kie_accepted,s.kie_unknown,s.kie_provider_task_id
    FROM media_reservations r
    JOIN media_accounts a ON a.id=r.account_id
    LEFT JOIN media_records m ON m.account_id=r.account_id AND m.id=r.job_id
      AND m.namespace IN ('history','codex','routerai')
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(amount) FILTER (WHERE kind='capture'),0) AS captured_units,
        COALESCE(SUM(amount) FILTER (WHERE kind='release'),0) AS released_units
      FROM media_ledger WHERE account_id=r.account_id AND reference=r.job_id
    ) l ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(BOOL_OR(outcome='accepted'),false) AS kie_accepted,
        COALESCE(BOOL_OR(outcome='unknown'),false) AS kie_unknown,
        MAX(provider_task_id) AS kie_provider_task_id
      FROM media_kie_submissions WHERE account_id=r.account_id AND job_id=r.job_id
    ) s ON true
    WHERE r.created_at >= now() - ($1::int * interval '1 day')
    ORDER BY r.created_at DESC,r.job_id DESC`, [period])).rows;
  const incidents = rows.map(classify).filter(Boolean);
  const priority = { confirmed_mismatch: 0, released_after_send: 1, held_unknown: 2 };
  incidents.sort((a, b) => priority[a.risk] - priority[b.risk] || new Date(b.createdAt) - new Date(a.createdAt));
  return {
    days: period,
    summary: {
      confirmedMismatch: incidents.filter(item => item.risk === 'confirmed_mismatch').length,
      releasedAfterSend: incidents.filter(item => item.risk === 'released_after_send').length,
      heldUnknown: incidents.filter(item => item.risk === 'held_unknown').length,
      reviewReleasedUnits: incidents.filter(item => item.risk !== 'held_unknown').reduce((sum, item) => sum + item.releasedUnits, 0),
    },
    incidents: incidents.slice(0, 200), totalIncidents: incidents.length,
  };
}

module.exports = { billingReconciliation };
