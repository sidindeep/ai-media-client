// Private worker shared by the exec and app-server transports.
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setMaxListeners } = require('node:events');
const { validateCodexRequest } = require('./codex-request');
const { createCodexLogin } = require('./codex-login');
const { normalizeUsage } = require('./codex-usage');
const { codexEnvironment } = require('./codex-runtime');
const { execute } = require('./codex-exec');
const { createCodexAppServerPool } = require('./codex-app-server-pool');
const { createCodexAppServer } = require('./codex-app-server');
const snapshotCatalog = require('../../config/codex-models.json');
const { validatePng } = require('./codex-images');
const { safeErrorText } = require('./codex-errors');
const systemErrors = require('../system-errors');
const { generationContext } = require('../ai-logger/generation-context.mjs');

function createCodexWorker(run, { login = createCodexLogin({ environment: codexEnvironment }),
  transport = process.env.MEDIA_CODEX_TRANSPORT || 'app-server',
  resultDirectory = process.env.MEDIA_CODEX_RESULT_DIR || path.join(os.tmpdir(), 'media-codex-results'),
  maxPendingJobs = Number(process.env.MEDIA_CODEX_MAX_PENDING_JOBS || 256),
  recordError = systemErrors.record } = {}) {
  if (!['exec', 'app-server'].includes(transport)) throw new Error('MEDIA_CODEX_TRANSPORT должен быть exec или app-server');
  if (!Number.isSafeInteger(maxPendingJobs) || maxPendingJobs < 1 || maxPendingJobs > 10000) throw new Error('MEDIA_CODEX_MAX_PENDING_JOBS должен быть от 1 до 10000');
  const adapter = !run && transport === 'app-server' ? createCodexAppServerPool() : null;
  const catalogAdapter = !run ? adapter || createCodexAppServer() : null;
  const models = () => catalogAdapter ? catalogAdapter.listModels() : Promise.resolve(snapshotCatalog);
  run = run || adapter?.run || execute;
  const controller = new AbortController();
  // Active and queued requests listen for shutdown; the app-server pool limits execution.
  setMaxListeners(0, controller.signal);
  const jobs = new Map(), admitting = new Map(), instanceId = randomUUID();
  const reportError = (event, error, request) => {
    try { recordError('provider', event, error, { diagnostic: { entity: 'provider' },
      generation: generationContext(request, 'codex') }); } catch {}
  };
  const sweep = setInterval(() => {
    const cutoff = Date.now() - 3600000;
    for (const [key, job] of jobs) if (job.state !== 'running' && job.createdAt < cutoff) jobs.delete(key);
  }, 60000);
  sweep.unref?.();
  const paths = (account, requestId) => {
    const directory = path.join(resultDirectory, account);
    return { directory, record: path.join(directory, requestId + '.json'), image: path.join(directory, requestId + '.png') };
  };
  async function atomicWrite(filename, bytes) {
    await fs.mkdir(path.dirname(filename), { recursive: true });
    const temporary = filename + '.' + randomUUID() + '.tmp';
    try { await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, filename); }
    finally { await fs.unlink(temporary).catch(() => {}); }
  }
  async function storedJob(account, requestId) {
    const key = account + ':' + requestId;
    if (jobs.has(key)) return jobs.get(key);
    const saved = await fs.readFile(paths(account, requestId).record, 'utf8').then(JSON.parse, error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (saved?.state === 'running') {
      saved.state = 'unknown';
      saved.error = 'Worker перезапустился во время генерации. Автоматический повтор отключён.';
      await atomicWrite(paths(account, requestId).record, JSON.stringify(saved));
    }
    if (saved) jobs.set(key, saved);
    return saved;
  }
  const send = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Codex-Worker-Instance': instanceId }); res.end(JSON.stringify(value)); };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://worker');
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, transport, ...(adapter ? { pool: adapter.status() } : {}) });
      const account = req.headers['x-account-id'];
      if (typeof account !== 'string' || !/^(local|[a-f0-9-]{36})$/.test(account)) return send(res, 403, { error: 'Доступ запрещён' });
      if (url.pathname === '/models' && req.method === 'GET') {
        try { return send(res, 200, await models()); }
        catch { return send(res, 503, { error: 'Каталог Codex временно недоступен' }); }
      }
      if (url.pathname === '/auth/status' && req.method === 'GET') return send(res, 200, await login.status());
      if (url.pathname === '/auth/limits' && req.method === 'GET') {
        if (!adapter) return send(res, 200, { rateLimits: null, rateLimitsByLimitId: null });
        return send(res, 200, await adapter.rateLimits());
      }
      if (url.pathname === '/auth/start' && req.method === 'POST') return send(res, 200, await login.start());
      if (url.pathname === '/auth/cancel' && req.method === 'POST') return send(res, 200, login.cancel());
      const now = Date.now();
      if (req.method === 'POST' && /^\/jobs\/[a-f0-9-]{36}\/ack$/.test(url.pathname)) {
        const requestId = url.pathname.split('/')[2];
        const job = await storedJob(account, requestId);
        if (!job || job.state !== 'success') return send(res, 404, { error: 'Задание не завершено' });
        if (job.hasImage) {
          if (!job.imageAcknowledged) {
            job.imageAcknowledged = true;
            await atomicWrite(paths(account, requestId).record, JSON.stringify(job));
          }
          await fs.unlink(paths(account, requestId).image).catch(error => { if (error.code !== 'ENOENT') throw error; });
        }
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && /^\/jobs\/[a-f0-9-]{36}\/image$/.test(url.pathname)) {
        const requestId = url.pathname.split('/')[2];
        const job = await storedJob(account, requestId);
        if (job?.state !== 'success' || !job.hasImage || job.imageAcknowledged) return send(res, 404, { error: 'Изображение не найдено' });
        const image = await fs.readFile(paths(account, requestId).image);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': image.length, 'Cache-Control': 'no-store' });
        return res.end(image);
      }
      if (req.method === 'GET' && /^\/jobs\/[a-f0-9-]{36}$/.test(url.pathname)) {
        const job = await storedJob(account, url.pathname.slice(6));
        return job ? send(res, 200, job) : send(res, 404, { error: 'Запрос не найден: сервис мог перезапуститься. Автоматический повтор отключён.' });
      }
      if (req.method !== 'POST' || url.pathname !== '/jobs') return send(res, 404, { error: 'Не найдено' });
      const chunks = []; let length = 0;
      for await (const chunk of req) { length += chunk.length; if (length > 128 * 1024 * 1024) return send(res, 413, { error: 'Запрос слишком большой' }); chunks.push(chunk); }
      const input = validateCodexRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')), (await models()).models);
      const key = account + ':' + input.requestId;
      const previous = await storedJob(account, input.requestId);
      if (previous) return send(res, 200, previous);
      if (admitting.has(key)) {
        await admitting.get(key);
        return send(res, 200, jobs.get(key));
      }
      if ([...jobs.values()].filter(item => item.state === 'running').length + admitting.size >= maxPendingJobs)
        return send(res, 429, { error: 'Очередь Codex заполнена', accepted: false });
      const job = { id: input.requestId, model: input.model, effort: input.effort, speed: input.speed, kind: input.kind || 'text', state: 'running', createdAt: now };
      const admission = atomicWrite(paths(account, input.requestId).record, JSON.stringify(job));
      admitting.set(key, admission);
      try { await admission; jobs.set(key, job); }
      finally { admitting.delete(key); }
      void Promise.resolve().then(() => run(input, { signal: controller.signal })).then(async output => {
        const completed = { ...job, state: 'success' };
        if (typeof output === 'string') completed.output = output;
        else {
          completed.output = output.output; completed.usage = normalizeUsage(output.usage);
          if (output.imageBase64) {
            const image = validatePng(Buffer.from(output.imageBase64, 'base64'));
            await atomicWrite(paths(account, input.requestId).image, image);
            completed.hasImage = true;
          }
        }
        // Polling must not expose success before the durable record is committed.
        await atomicWrite(paths(account, input.requestId).record, JSON.stringify(completed));
        Object.assign(job, completed);
      }, async error => {
        reportError('codex-worker.run.error', error, input);
        const explanation = safeErrorText(error.ownerMessage);
        const failed = { ...job, error: safeErrorText(error.message) || 'Codex request failed.',
          ...(error.code ? { errorCode: safeErrorText(String(error.code)).slice(0, 100) } : {}),
          state: error.outcomeUnknown ? 'unknown' : 'failed' };
        if (explanation) failed.error = safeErrorText(failed.error + '\n\nОтвет модели: ' + explanation);
        await atomicWrite(paths(account, input.requestId).record, JSON.stringify(failed));
        Object.assign(job, failed);
      }).catch(error => { reportError('codex-worker.persist.error', error, input); job.error = safeErrorText(error.message) || 'Codex result could not be saved.'; job.state = 'unknown'; });
      return send(res, 202, job);
    } catch (error) { send(res, error.status || 400, { error: error.status ? error.message : 'Некорректный запрос' }); }
  });
  server.requestTimeout = 15000;
  server.stopActive = () => { controller.abort(); catalogAdapter?.close(); login.close(); };
  server.on('close', () => { clearInterval(sweep); catalogAdapter?.close(); login.close(); });
  return server;
}
if (require.main === module) createCodexWorker().listen(3210, '0.0.0.0', () => console.log('Codex worker ready'));
module.exports = { createCodexWorker, codexEnvironment };
