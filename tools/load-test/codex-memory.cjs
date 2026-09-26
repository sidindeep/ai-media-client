// Manual free soak in the fresh test image: docker compose --profile test run ...
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { createCodexWorker } = require('../../src/services/codex-worker');

const minutes = Number(process.argv[2] || 70);
if (!Number.isFinite(minutes) || minutes < 0.1 || minutes > 120) throw new Error('Duration must be 0.1..120 minutes');
const reportFile = process.argv[3] || '/results/memory-codex.json';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
async function main() {
const resultDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'media-codex-soak-'));
const server = createCodexWorker(async () => ({ output: 'ok', imageBase64: png,
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }), { resultDirectory });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const headers = { 'x-account-id': randomUUID() };
const started = Date.now(), samples = []; let completed = 0;
async function sample() {
  const memory = process.memoryUsage();
  samples.push({ minutes: Number(((Date.now() - started) / 60000).toFixed(2)), completed,
    rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, externalBytes: memory.external });
  await fs.mkdir(path.dirname(reportFile), { recursive: true });
  await fs.writeFile(reportFile, JSON.stringify({ durationMinutes: minutes, completed, samples }, null, 2));
  if (samples.length % 5 === 0) console.log(JSON.stringify(samples.at(-1)));
}
const ticker = setInterval(() => { void sample().catch(error => console.error(error.message)); }, 60000);
try {
  await sample();
  while (Date.now() - started < minutes * 60000) {
    const requestId = randomUUID();
    const response = await fetch(base + '/jobs', { method: 'POST', headers, body: JSON.stringify({
      requestId, kind: 'image', prompt: 'Free memory soak', model: 'gpt-6-astra', effort: 'medium', speed: 'standard',
    }) });
    if (response.status !== 202) throw new Error(`Worker rejected mock job: ${response.status}`);
    let done = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      const status = await fetch(base + '/jobs/' + requestId, { headers }).then(result => result.json());
      if (status.state === 'success') { done = true; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (!done) throw new Error('Mock worker did not finish');
    const image = await fetch(base + '/jobs/' + requestId + '/image', { headers });
    if (image.status !== 200 || (await image.arrayBuffer()).byteLength < 50) throw new Error('Worker image missing');
    const ack = await fetch(base + '/jobs/' + requestId + '/ack', { method: 'POST', headers });
    if (!ack.ok) throw new Error('Worker image acknowledgement failed');
    completed++;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  await sample();
  console.log(JSON.stringify({ complete: true, durationMinutes: minutes, completed, first: samples[0], last: samples.at(-1) }));
} finally {
  clearInterval(ticker);
  server.stopActive();
  server.closeIdleConnections();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(resultDirectory, { recursive: true, force: true });
}
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
