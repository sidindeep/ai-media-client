async function main() {
  const limit = Number(process.argv[2] || 50);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Limit must be 1..200');
  const project = process.env.AI_LOGGER_PROJECT;
  if (!project || !process.env.AI_LOGGER_SERVER_URL) throw new Error('AI_LOGGER_PROJECT and AI_LOGGER_SERVER_URL are required');
  // Read uses HTTP only; never connect to the logger database.
  const url = new URL(process.env.AI_LOGGER_READ_URL || '/api/agent/logs', process.env.AI_LOGGER_SERVER_URL);
  url.searchParams.set('project', project);
  url.searchParams.set('limit', String(limit));
  const headers = process.env.AI_LOGGER_READ_TOKEN ? { Authorization: `Bearer ${process.env.AI_LOGGER_READ_TOKEN}` } : {};
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Logger read HTTP ${response.status}`);
  const result = await response.json();
  if (!Array.isArray(result.records)) throw new Error('Invalid logger read response');
  process.stdout.write(JSON.stringify(result.records, null, 2) + '\n');
}
main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
