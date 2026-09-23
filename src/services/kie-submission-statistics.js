async function kieSubmissionStatistics(pool, days = 30) {
  const period = Number(days);
  if (![7, 30, 90].includes(period)) throw Object.assign(new Error('Некорректный период'), { status: 400 });
  const rows = (await pool.query(`SELECT s.id,s.account_id,s.job_id,s.request_id,s.kie_account_id,s.project_id,s.chat_id,
      s.model_id,s.started_at,s.finished_at,s.outcome,s.provider_task_id,s.error_code,s.error_message,
      a.display_name AS account_name
    FROM media_kie_submissions s JOIN media_accounts a ON a.id=s.account_id
    WHERE s.started_at >= now() - ($1::int * interval '1 day') ORDER BY s.started_at DESC,s.id DESC`, [period])).rows;
  const jobs = new Map();
  for (const row of rows) {
    const key = `${row.account_id}:${row.job_id}`;
    const job = jobs.get(key) || { date: row.started_at, unknown: false, attempts: 0 };
    job.date = row.started_at; // Query is newest first, so this becomes the first submission date.
    job.unknown ||= row.outcome === 'unknown';
    job.attempts++;
    jobs.set(key, job);
  }
  const daily = new Map();
  for (const job of jobs.values()) {
    const date = new Date(job.date).toISOString().slice(0, 10);
    const item = daily.get(date) || { date, submitted: 0, unknown: 0 };
    item.submitted++;
    if (job.unknown) item.unknown++;
    daily.set(date, item);
  }
  const unknown = [...jobs.values()].filter(job => job.unknown).length;
  const submitted = jobs.size;
  return { days: period, submitted, unknown, ratePercent: submitted ? Math.round(unknown / submitted * 10000) / 100 : 0,
    attempts: rows.length, daily: [...daily.values()].sort((a,b) => a.date.localeCompare(b.date)),
    incidents: rows.filter(row => row.outcome === 'unknown').slice(0, 200).map(row => ({
      id: row.id, accountId: row.account_id, accountName: row.account_name, jobId: row.job_id,
      requestId: row.request_id, kieAccountId: row.kie_account_id, projectId: row.project_id, chatId: row.chat_id,
      modelId: row.model_id, startedAt: row.started_at, finishedAt: row.finished_at,
      providerTaskId: row.provider_task_id, errorCode: row.error_code, errorMessage: row.error_message
    })) };
}
module.exports = { kieSubmissionStatistics };
