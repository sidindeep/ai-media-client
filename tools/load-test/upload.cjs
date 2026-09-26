// Free B12 load: authenticated files on the isolated Compose, no provider calls.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const base = process.env.BASE_URL || 'http://127.0.0.1:3001';
if (!['http://127.0.0.1:3001', 'http://127.0.0.1:3002'].includes(base)) throw new Error('BASE_URL must be an isolated local Compose port');
const runId = process.argv[2], count = Number(process.argv[3] || 25), sizeMiB = Number(process.argv[4] || 16);
if (!/^[a-zA-Z0-9_-]{4,80}$/.test(runId || '') || !Number.isInteger(count) || count < 1 || count > 25
  || !Number.isInteger(sizeMiB) || sizeMiB < 1 || sizeMiB > 64) throw new Error('Usage: upload.cjs <prepared-run-id> [1..25] [1..64 MiB]');
const directory = path.join(root, 'artifacts', 'load-tests', runId);
const sessions = JSON.parse(fs.readFileSync(path.join(directory, 'sessions.json'), 'utf8'));
if (sessions.length < count) throw new Error('Prepare one account per upload first');

async function health() {
  const response = await fetch(base + '/api/health');
  if (!response.ok) throw new Error(`Health: ${response.status}`);
  return response.json();
}
async function main() {
  const body = Buffer.alloc(sizeMiB * 1024 * 1024, 0x5a);
  const before = await health();
  const results = []; let next = 0;
  async function worker() {
    while (next < count) {
      const index = next++, session = sessions[index];
      const started = performance.now();
      const response = await fetch(`${base}/api/source?name=load-${runId}-${index}.png`, {
        method: 'POST', headers: { Cookie: session.cookie, 'X-Media-Client': 'web', 'X-Media-User': session.id, 'Content-Type': 'image/png' }, body,
        signal: AbortSignal.timeout(120000),
      });
      const value = await response.json();
      results.push({ index, status: response.status, size: value.result?.size, ms: performance.now() - started });
      if (response.status !== 200 || value.result?.size !== body.length) throw new Error(`Upload ${index}: ${response.status} ${value.error || 'unexpected result size'}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, count) }, worker));
  const after = await health();
  const times = results.map(item => item.ms).sort((a, b) => a - b);
  const data = path.join(root, 'data', 'load-test-service');
  const folders = [path.join(data, 'content-staging'), ...sessions.slice(0, count).map(item => path.join(data, 'accounts', item.id, 'sources'))];
  const leftovers = folders.flatMap(folder => fs.existsSync(folder)
    ? fs.readdirSync(folder).filter(name => name.endsWith('.stage') || name.endsWith('.part')) : []);
  const report = { runId, base, count, sizeMiB, accepted: results.filter(item => item.status === 200).length,
    p95Ms: times[Math.ceil(times.length * 0.95) - 1], rssBefore: before.runtime?.rssBytes,
    rssAfter: after.runtime?.rssBytes, stagingLeftovers: leftovers.length };
  fs.writeFileSync(path.join(directory, 'upload.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (leftovers.length) process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
