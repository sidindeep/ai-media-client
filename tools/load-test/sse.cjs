const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const runId = process.argv[2];
const count = Number(process.argv[3] || 25);
const expected = Number(process.argv[4] || count);
const oneAccount = process.argv[5] === 'one';
if (!/^[a-zA-Z0-9_-]{4,80}$/.test(runId || '') || !Number.isInteger(count) || count < 1 || count > 500
  || !Number.isInteger(expected) || expected < 0 || expected > count || (process.argv[5] && !oneAccount)) {
  throw new Error('Usage: node tools/load-test/sse.cjs <run-id> [connections: 1..500] [expected accepted] [one]');
}
const directory = path.join(root, 'artifacts', 'load-tests', runId);
const sessions = JSON.parse(fs.readFileSync(path.join(directory, 'sessions.json'), 'utf8'));
if (!sessions.length) throw new Error('No test sessions');

function connect(cookie) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const request = http.request('http://127.0.0.1:3001/api/events', {
      headers: { Cookie: cookie }, timeout: 10000,
    }, response => {
      response.on('error', () => {});
      response.resume();
      resolve({ request, response, status: response.statusCode, setupMs: performance.now() - started });
    });
    request.on('timeout', () => request.destroy(new Error('SSE timeout')));
    request.on('error', reject);
    request.end();
  });
}

async function main() {
  const opened = await Promise.all(Array.from({ length: count }, (_, index) => connect(sessions[oneAccount ? 0 : index % sessions.length].cookie)));
  const statuses = Object.fromEntries([...new Set(opened.map(item => item.status))].map(status => [status, opened.filter(item => item.status === status).length]));
  const setup = opened.map(item => item.setupMs).sort((a, b) => a - b);
  const result = { requested: count, statuses, setupP95Ms: setup[Math.ceil(setup.length * 0.95) - 1],
    acceptedStillOpen: opened.filter(item => item.status === 200 && !item.response.destroyed).length };
  opened.forEach(item => item.request.destroy());
  await new Promise(resolve => setTimeout(resolve, 500));
  const retry = await connect(sessions[0].cookie);
  result.reconnectStatus = retry.status;
  retry.request.destroy();
  fs.writeFileSync(path.join(directory, oneAccount ? 'sse-one-account.json' : 'sse.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  if (result.reconnectStatus !== 200 || result.statuses[200] !== expected) process.exitCode = 1;
}
main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
