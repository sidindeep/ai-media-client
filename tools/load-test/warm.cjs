const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const runId = process.argv[2];
const port = Number(process.argv[3] || 3001);
if (!/^[a-zA-Z0-9_-]{4,80}$/.test(runId || '') || ![3001, 3002].includes(port))
  throw new Error('Usage: warm.cjs <prepared-run-id> [3001|3002]');
const sessions = JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'load-tests', runId, 'sessions.json'), 'utf8'));
const latencies = [];
async function main() {
  for (const session of sessions) {
    for (const route of ['/app', '/api/account', '/api/workspace/sync']) {
      const started = performance.now();
      const response = await fetch(`http://127.0.0.1:${port}${route}`, { headers: { Cookie: session.cookie }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`Warmup ${route}: HTTP ${response.status}`);
      await response.arrayBuffer();
      latencies.push(performance.now() - started);
    }
  }
  latencies.sort((a, b) => a - b);
  console.log(JSON.stringify({ runId, port, sessions: sessions.length, requests: latencies.length,
    p95Ms: latencies[Math.ceil(latencies.length * 0.95) - 1], maxMs: latencies.at(-1) }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
