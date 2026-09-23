const CATEGORIES = new Set(['all', 'image', 'video', 'text', 'audio', 'other']);
const PERIODS = new Set([7, 30, 90]);
const PAGE_SIZE = 30;

function options(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('Некорректный фильтр расходов'), { status: 400 });
  const days = Number(input.days ?? 30);
  const category = String(input.category ?? 'all');
  if (!PERIODS.has(days) || !CATEGORIES.has(category)) throw Object.assign(new Error('Некорректный фильтр расходов'), { status: 400 });
  const asOf = input.asOf ? new Date(input.asOf) : new Date();
  if (!Number.isFinite(asOf.getTime()) || asOf.getTime() > Date.now() + 60000) throw Object.assign(new Error('Некорректная дата расходов'), { status: 400 });
  let cursor = null;
  if (input.cursor != null) {
    try {
      cursor = JSON.parse(Buffer.from(String(input.cursor), 'base64url').toString('utf8'));
      if (!Array.isArray(cursor) || cursor.length !== 2 || typeof cursor[0] !== 'string' || !Number.isFinite(Date.parse(cursor[0])) || typeof cursor[1] !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(cursor[1])) throw new Error();
    } catch { throw Object.assign(new Error('Некорректная страница расходов'), { status: 400 }); }
  }
  return { days, category, asOf: asOf.toISOString(), since: new Date(asOf.getTime() - days * 86400000).toISOString(), cursor };
}

const entries = `WITH entries AS (
  SELECT l.id,l.kind,l.reference,l.amount,l.created_at,
    COALESCE(NULLIF(l.details->>'category',''),
      CASE WHEN COALESCE(r.data->>'modelKind',r.data->>'kind') IN ('image','video','text','audio')
        THEN COALESCE(r.data->>'modelKind',r.data->>'kind') ELSE 'other' END) AS category,
    COALESCE(NULLIF(l.details->>'modelName',''),r.data->>'modelName',r.data->>'model',r.data->>'modelId') AS model_name,
    COALESCE(NULLIF(l.details->>'recordId',''),
      CASE WHEN r.namespace='history' THEN r.id WHEN r.namespace IN ('codex','routerai')
        THEN r.namespace || ':' || (r.data->>'id') END) AS record_id
  FROM media_ledger l
  LEFT JOIN LATERAL (
    SELECT namespace,id,data FROM media_records
    WHERE account_id=l.account_id AND id=l.reference AND namespace IN ('history','codex','routerai')
    LIMIT 1
  ) r ON true
  WHERE l.account_id=$1 AND l.kind IN ('capture','release') AND l.created_at >= $2::timestamptz AND l.created_at <= $3::timestamptz
)`;

async function spendingHistory(pool, accountId, input) {
  const filter = options(input);
  const params = [accountId, filter.since, filter.asOf, filter.category];
  const categoryWhere = "($4='all' OR category=$4)";
  const [groups, page] = await Promise.all([
    pool.query(`${entries} SELECT category,kind,SUM(amount)::text AS amount FROM entries WHERE ${categoryWhere} GROUP BY category,kind`, params),
    pool.query(`${entries} SELECT id,kind,amount,created_at,category,model_name,record_id
      FROM entries WHERE ${categoryWhere}
        AND ($5::timestamptz IS NULL OR (created_at,id)<($5::timestamptz,$6::uuid))
      ORDER BY created_at DESC,id DESC LIMIT ${PAGE_SIZE + 1}`,
    [...params, filter.cursor?.[0] || null, filter.cursor?.[1] || null]),
  ]);
  let spentUnits = 0, releasedUnits = 0;
  const byCategory = {};
  for (const row of groups.rows) {
    const amount = Number(row.amount);
    if (row.kind === 'capture') { spentUnits += amount; byCategory[row.category] = (byCategory[row.category] || 0) + amount; }
    else releasedUnits += amount;
  }
  const topCategory = Object.entries(byCategory).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || null;
  const rows = page.rows.slice(0, PAGE_SIZE);
  const last = rows.at(-1);
  return {
    days: filter.days, category: filter.category, asOf: filter.asOf,
    summary: { spentUnits, releasedUnits, topCategory },
    items: rows.map(row => ({ id: row.id, kind: row.kind, amountUnits: Number(row.amount),
      createdAt: row.created_at, category: row.category, modelName: row.model_name || null, recordId: row.record_id || null })),
    nextCursor: page.rows.length > PAGE_SIZE && last
      ? Buffer.from(JSON.stringify([new Date(last.created_at).toISOString(), last.id])).toString('base64url') : null,
  };
}

module.exports = { spendingHistory };
