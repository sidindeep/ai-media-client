const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const runId = process.argv[2];
if (!/^[a-zA-Z0-9_-]{4,80}$/.test(runId || '')) throw new Error('Usage: replica-failover.cjs <prepared-run-id>');
const root = path.resolve(__dirname, '../..');
const directory = path.join(root, 'artifacts', 'load-tests', runId);
const [session] = JSON.parse(fs.readFileSync(path.join(directory, 'sessions.json'), 'utf8'));
if (!session?.cookie || !session?.id) throw new Error('Prepared session is missing');

async function main() {
  const health = await fetch('http://127.0.0.1:3002/api/health', { signal: AbortSignal.timeout(10000) });
  const status = await health.json();
  if (!health.ok || status.runtime?.replicaRole !== 'web') throw new Error(`Web replica unhealthy: ${health.status}`);
  const read = await fetch('http://127.0.0.1:3002/api/workspace/sync', {
    headers: { Cookie: session.cookie }, signal: AbortSignal.timeout(10000),
  });
  if (!read.ok || !(await read.json()).result?.records) throw new Error(`Web read failed: ${read.status}`);
  const requestId = `load:executor-down:${randomUUID()}`;
  const write = await fetch('http://127.0.0.1:3002/api/rpc/createTask', {
    method: 'POST', signal: AbortSignal.timeout(10000),
    headers: { Cookie: session.cookie, 'X-Media-Client': 'web', 'X-Media-User': session.id,
      Origin: 'http://127.0.0.1:3002', 'Content-Type': 'application/json' },
    body: JSON.stringify([{ requestId, modelId: 'kie:grok-imagine-video-1-5-preview',
      input: { prompt: 'Executor unavailable probe', duration: 8, aspect_ratio: '16:9', resolution: '720p' }, sourceFiles: [] }]),
  });
  if (write.status !== 503) throw new Error(`Expected 503 while executor is stopped, got ${write.status}`);
  const result = { runId, webHealth: health.status, webRead: read.status, webWrite: write.status };
  fs.writeFileSync(path.join(directory, 'executor-down.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
