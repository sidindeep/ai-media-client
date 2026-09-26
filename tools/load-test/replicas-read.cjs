const fs = require('node:fs');
const dns = require('node:dns/promises');
const http = require('node:http');
const path = require('node:path');

const runId = process.argv[2];
const expected = Number(process.argv[3]);
const seconds = Number(process.argv[4] || 60);
const rate = Number(process.argv[5] || 8);
if (!/^[a-zA-Z0-9_-]{4,80}$/.test(runId || '') || ![2, 5, 10].includes(expected)
  || !Number.isInteger(seconds) || seconds < 10 || seconds > 600
  || !Number.isInteger(rate) || rate < 1 || rate > 50)
  throw new Error('Usage: replicas-read.cjs <run-id> <2|5|10> [seconds] [cycles/s]');
const sessions = JSON.parse(fs.readFileSync(`/results/${runId}/sessions.json`, 'utf8'));
if (!sessions.length) throw new Error('Prepared sessions are missing');
const names = ['landing', 'studio', 'account', 'workspace-full', 'workspace-delta'];
const routes = ['/', '/app', '/api/account', '/api/workspace/sync'];
const metrics = Object.fromEntries(names.map(name => [name, []]));
const byIp = new Map();
let completed = 0, failed = 0, dropped = 0, active = 0;
const errors = [];
const percentile = (values, ratio) => values.length ? values.sort((a, b) => a - b)[Math.ceil(values.length * ratio) - 1] : null;

async function main() {
  const ips = [...new Set(await dns.resolve4('media-web-scale'))];
  if (ips.length !== expected) throw new Error(`Expected ${expected} replica IPs, Docker DNS returned ${ips.length}: ${ips.join(',')}`);
  const request = async (ip, route, name, cookie) => {
    const started = performance.now();
    const response = await new Promise((resolve, reject) => {
      const request = http.get({ hostname: ip, port: 3000, path: route, timeout: 10000,
        headers: { Host: '127.0.0.1:3001', ...(cookie ? { Cookie: cookie } : {}) } }, result => {
        const chunks = [];
        result.on('data', chunk => chunks.push(chunk));
        result.once('end', () => resolve({ status: result.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        result.once('error', reject);
      });
      request.once('timeout', () => request.destroy(new Error(`${name}: timeout`)));
      request.once('error', reject);
    });
    metrics[name].push(performance.now() - started);
    if (response.status !== 200) throw new Error(`${name}: HTTP ${response.status}`);
    return name === 'workspace-full' ? JSON.parse(response.body).result?.cursor : null;
  };
  const cycle = async number => {
    const ip = ips[number % ips.length];
    const cookie = sessions[number % sessions.length].cookie;
    byIp.set(ip, (byIp.get(ip) || 0) + 1);
    try {
      for (let index = 0; index < routes.length; index++) {
        const cursor = await request(ip, routes[index], names[index], index ? cookie : null);
        if (index === 3) {
          if (!cursor || Number.isNaN(Date.parse(cursor))) throw new Error('Workspace cursor missing');
          await request(ip, `/api/workspace/sync?since=${encodeURIComponent(cursor)}`, 'workspace-delta', cookie);
        }
      }
      completed++;
    } catch (error) { failed++; if (errors.length < 10) errors.push(error.message); }
    finally { active--; }
  };
  const total = seconds * rate;
  const startedAt = Date.now();
  for (let number = 0; number < total; number++) {
    const due = startedAt + number * 1000 / rate;
    const delay = due - Date.now();
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    if (active >= 25) { dropped++; continue; }
    active++;
    void cycle(number);
  }
  while (active) await new Promise(resolve => setTimeout(resolve, 100));
  const result = { runId, replicas: expected, seconds, rate, requested: total, completed, failed, dropped,
    perReplicaCycles: Object.fromEntries(byIp), errors,
    routes: Object.fromEntries(names.map(name => [name, { count: metrics[name].length, p95Ms: percentile(metrics[name], 0.95), p99Ms: percentile(metrics[name], 0.99) }])) };
  fs.writeFileSync(path.join('/results', runId, `replicas-${expected}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  if (failed || dropped || completed !== total || [...byIp.values()].some(value => value === 0)) process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
