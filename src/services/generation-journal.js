const { randomUUID } = require('node:crypto');

const NAMESPACE = 'generation-journal';

function entry(provider, record, event, details = {}) {
  return {
    id: randomUUID(), provider, event,
    requestId: record.requestId || record.id || null,
    jobId: record.id || null,
    model: record.model || record.modelId || null,
    kind: record.modelKind || record.kind || null,
    state: record.state || null,
    projectId: record.projectId || null,
    chatId: record.chatId || null,
    quotedCredits: record.nativeQuote?.credits ?? null,
    priceVersion: record.nativeQuote?.version || null,
    providerTaskId: details.providerTaskId || record.providerVideoId || record.taskId || null,
    providerCostRub: Number.isFinite(details.providerCostRub) ? details.providerCostRub
      : Number.isFinite(record.providerCostRub) ? record.providerCostRub : null,
    error: typeof details.error === 'string' ? details.error.slice(0, 500) : null,
    createdAt: new Date().toISOString(),
  };
}

async function appendGenerationEvent(client, accountId, provider, record, event, details) {
  const item = entry(provider, record, event, details);
  await client.query('INSERT INTO media_records(account_id,namespace,id,data) VALUES($1,$2,$3,$4)',
    [accountId, NAMESPACE, item.id, JSON.stringify(item)]);
  return item;
}

async function generationJournal(pool, accountId, input = {}, admin = false) {
  const offset = Number(input?.offset ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) {
    throw Object.assign(new Error('Некорректная страница журнала'), { status: 400 });
  }
  const provider = String(input?.provider || 'all');
  if (!['all', 'kie', 'routerai', 'codex'].includes(provider)) {
    throw Object.assign(new Error('Некорректный провайдер журнала'), { status: 400 });
  }
  const [result, totals] = await Promise.all([
    pool.query(`SELECT data FROM media_records
      WHERE account_id=$1 AND namespace=$2 AND ($3='all' OR data->>'provider'=$3)
      ORDER BY updated_at DESC,id DESC LIMIT 51 OFFSET $4`, [accountId, NAMESPACE, provider, offset]),
    pool.query(`SELECT COUNT(*) FILTER (WHERE data->>'event'='created')::int AS generations,
      COUNT(*) FILTER (WHERE data->>'event' IN ('submitting','send_start'))::int AS send_attempts
      FROM media_records WHERE account_id=$1 AND namespace=$2 AND ($3='all' OR data->>'provider'=$3)`,
    [accountId, NAMESPACE, provider]),
  ]);
  const items = result.rows.slice(0, 50).map(row => {
    const item = row.data;
    if (admin) return item;
    const { providerTaskId, providerCostRub, error, ...safe } = item;
    return safe;
  });
  return { items, summary: { generations: totals.rows[0]?.generations || 0,
    sendAttempts: totals.rows[0]?.send_attempts || 0 }, nextOffset: result.rows.length > 50 ? offset + 50 : null };
}

module.exports = { appendGenerationEvent, generationJournal };
