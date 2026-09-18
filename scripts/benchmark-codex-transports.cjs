// Bounded adapter A/B probe, not an end-to-end capacity test. See docs/codex-transports.md.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const args = process.argv.slice(2);
if (!args.includes('--live')) throw new Error('Live calls require --live (maximum 6 text + 6 image requests).');
if (args.some(arg => !['--live', '--docker', '--text-only'].includes(arg))) throw new Error('Unsupported benchmark argument');
if (args.includes('--docker')) {
  const { spawn } = require('node:child_process');
  const root = path.resolve(__dirname, '..');
  const dir = path.join(root, 'artifacts', 'load-tests', 'transport-' + new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const output = fs.createWriteStream(path.join(dir, 'events.jsonl'), { encoding: 'utf8' });
  const child = spawn('docker', ['compose', 'exec', '-T', 'codex', 'node', '-', ...args.filter(arg => arg !== '--docker')], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
  child.stdin.end(fs.readFileSync(__filename));
  child.stdout.on('data', chunk => { process.stdout.write(chunk); output.write(chunk); });
  child.on('error', () => { output.end(); process.exitCode = 1; });
  child.on('close', code => { output.end(); console.log('Evidence: ' + dir); process.exitCode = code || 0; });
} else {
  const root = process.cwd();
  const { execute } = require(path.join(root, 'src/services/codex-exec'));
  const { createCodexAppServer } = require(path.join(root, 'src/services/codex-app-server'));
  const { validateCodexRequest } = require(path.join(root, 'src/services/codex-request'));
  const { validatePng } = require(path.join(root, 'src/services/codex-images'));
  const catalog = require(path.join(root, 'config/codex-models.json'));
  const app = createCodexAppServer();
  const emit = value => console.log(JSON.stringify({ at: new Date().toISOString(), ...value }));
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  function resources() {
    let rssKiB = 0, pssKiB = 0, processes = 0;
    const records = fs.readdirSync('/proc').filter(n => /^\d+$/.test(n)).flatMap(pid => {
      try { const status = fs.readFileSync('/proc/' + pid + '/status', 'utf8'); return [{ pid: Number(pid), ppid: Number(status.match(/^PPid:\s+(\d+)/m)?.[1]) }]; } catch { return []; }
    });
    const own = new Set([process.pid]);
    for (let changed = true; changed;) { changed = false; for (const r of records) if (own.has(r.ppid) && !own.has(r.pid)) { own.add(r.pid); changed = true; } }
    for (const pid of own) {
      try { const memory = fs.readFileSync('/proc/' + pid + '/smaps_rollup', 'utf8'); rssKiB += Number(memory.match(/^Rss:\s+(\d+)/m)?.[1] || 0); pssKiB += Number(memory.match(/^Pss:\s+(\d+)/m)?.[1] || 0); processes++; } catch {}
    }
    let cpuUsec = null, containerBytes = null;
    try { cpuUsec = Number(fs.readFileSync('/sys/fs/cgroup/cpu.stat', 'utf8').match(/usage_usec (\d+)/)?.[1]); } catch {}
    try { containerBytes = Number(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8')); } catch {}
    return { rssKiB, pssKiB, processes, cpuUsec, containerBytes };
  }
  let sent = 0, stop = false;
  async function wave(transport, kind, concurrency) {
    if (stop) return;
    const before = resources(), start = performance.now();
    const peak = { ...before }; let samples = 0;
    const sample = () => { const r = resources(); samples++; for (const k of ['rssKiB', 'pssKiB', 'processes', 'containerBytes']) peak[k] = Math.max(peak[k] || 0, r[k] || 0); };
    const ticker = setInterval(sample, 200);
    const results = await Promise.all(Array.from({ length: concurrency }, async () => {
      if (++sent > 12) throw new Error('Budget exceeded');
      const request = validateCodexRequest({ requestId: randomUUID(), kind, model: catalog.uiDefaults.model,
        effort: catalog.uiDefaults.effort, speed: catalog.uiDefaults.speed,
        prompt: kind === 'text' ? 'Write exactly three short English sentences describing a quiet garden. No headings.'
          : 'One simple watercolor illustration of a small red apple on a plain white background. No text.' });
      const began = performance.now();
      emit({ event: 'submitted', transport, kind, concurrency, requestId: request.requestId, sent });
      try {
        const result = await (transport === 'exec' ? execute(request) : app.run(request));
        let imageBytes = 0;
        if (kind === 'image') imageBytes = validatePng(Buffer.from(result.imageBase64 || '', 'base64')).length;
        const value = { ok: true, seconds: (performance.now() - began) / 1000, usage: result.usage, imageBytes };
        emit({ event: 'completed', transport, kind, requestId: request.requestId, ...value }); return value;
      } catch (error) {
        stop = true;
        const value = { ok: false, seconds: (performance.now() - began) / 1000, unknown: Boolean(error.outcomeUnknown), error: error.message };
        emit({ event: 'completed', transport, kind, requestId: request.requestId, ...value }); return value;
      }
    }));
    clearInterval(ticker); sample();
    const after = resources(), seconds = (performance.now() - start) / 1000;
    emit({ event: 'wave', transport, kind, concurrency, seconds, samples, success: results.filter(r => r.ok).length,
      perMinute: 60 * results.filter(r => r.ok).length / seconds, before, peak, after,
      containerCpuSeconds: before.cpuUsec === null || after.cpuUsec === null ? null : (after.cpuUsec - before.cpuUsec) / 1e6 });
    await sleep(1000);
  }
  (async () => {
    emit({ event: 'manifest', model: catalog.uiDefaults.model, effort: catalog.uiDefaults.effort, speed: catalog.uiDefaults.speed,
      cli: catalog.version, scope: 'adapter-only; no web billing or result cache; local Compose', budget: { text: 6, image: args.includes('--text-only') ? 0 : 6 }, resources: resources() });
    for (const concurrency of [1, 2]) {
      await wave('app-server', 'text', concurrency); await wave('exec', 'text', concurrency);
    }
    if (!args.includes('--text-only')) for (const concurrency of [1, 2]) {
      await wave('exec', 'image', concurrency); await wave('app-server', 'image', concurrency);
    }
    emit({ event: 'end', sent, stoppedOnError: stop, resources: resources() });
    if (stop) process.exitCode = 1;
  })().catch(error => { emit({ event: 'fatal', error: error.message }); process.exitCode = 1; }).finally(() => app.close());
}
