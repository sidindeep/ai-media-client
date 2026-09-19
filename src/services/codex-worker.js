// Private worker shared by the exec and app-server transports.
const http = require('node:http');
const { setMaxListeners } = require('node:events');
const { validateCodexRequest } = require('./codex-request');
const { createCodexLogin } = require('./codex-login');
const { normalizeUsage } = require('./codex-usage');
const { codexEnvironment } = require('./codex-runtime');
const { execute } = require('./codex-exec');
const { createCodexAppServerPool } = require('./codex-app-server-pool');

function createCodexWorker(run, { login = createCodexLogin({ environment: codexEnvironment }),
  transport = process.env.MEDIA_CODEX_TRANSPORT || 'app-server' } = {}) {
  if (!['exec', 'app-server'].includes(transport)) throw new Error('MEDIA_CODEX_TRANSPORT должен быть exec или app-server');
  const adapter = !run && transport === 'app-server' ? createCodexAppServerPool() : null;
  run = run || adapter?.run || execute;
  const controller = new AbortController();
  // Active and queued requests listen for shutdown; the app-server pool limits execution.
  setMaxListeners(0, controller.signal);
  const jobs = new Map();
  const send = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://worker');
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, transport, ...(adapter ? { pool: adapter.status() } : {}) });
      const account = req.headers['x-account-id'];
      if (typeof account !== 'string' || !/^(local|[a-f0-9-]{36})$/.test(account)) return send(res, 403, { error: 'Доступ запрещён' });
      if (url.pathname === '/auth/status' && req.method === 'GET') return send(res, 200, await login.status());
      if (url.pathname === '/auth/start' && req.method === 'POST') return send(res, 200, await login.start());
      if (url.pathname === '/auth/cancel' && req.method === 'POST') return send(res, 200, login.cancel());
      const now = Date.now();
      for (const [key, job] of jobs) if (job.state !== 'running' && now - job.createdAt > 3600000) jobs.delete(key);
      if (req.method === 'GET' && /^\/jobs\/[a-f0-9-]{36}$/.test(url.pathname)) {
        const job = jobs.get(account + ':' + url.pathname.slice(6));
        return job ? send(res, 200, job) : send(res, 404, { error: 'Запрос не найден: сервис мог перезапуститься. Автоматический повтор отключён.' });
      }
      if (req.method !== 'POST' || url.pathname !== '/jobs') return send(res, 404, { error: 'Не найдено' });
      const chunks = []; let length = 0;
      for await (const chunk of req) { length += chunk.length; if (length > 128 * 1024 * 1024) return send(res, 413, { error: 'Запрос слишком большой' }); chunks.push(chunk); }
      const input = validateCodexRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const key = account + ':' + input.requestId;
      if (jobs.has(key)) return send(res, 200, jobs.get(key));
      const job = { id: input.requestId, model: input.model, effort: input.effort, speed: input.speed, kind: input.kind || 'text', state: 'running', createdAt: now };
      jobs.set(key, job);
      void Promise.resolve().then(() => run(input, { signal: controller.signal })).then(output => {
        if (typeof output === 'string') job.output = output;
        else { job.output = output.output; job.imageBase64 = output.imageBase64; job.usage = normalizeUsage(output.usage); }
        job.state = 'success';
      }, error => { job.error = error.message; job.state = error.outcomeUnknown ? 'unknown' : 'failed'; });
      return send(res, 202, job);
    } catch (error) { send(res, error.status || 400, { error: error.status ? error.message : 'Некорректный запрос' }); }
  });
  server.requestTimeout = 15000;
  server.stopActive = () => { controller.abort(); adapter?.close(); login.close(); };
  server.on('close', () => { adapter?.close(); login.close(); });
  return server;
}
if (require.main === module) createCodexWorker().listen(3210, '0.0.0.0', () => console.log('Codex worker ready'));
module.exports = { createCodexWorker, codexEnvironment };
