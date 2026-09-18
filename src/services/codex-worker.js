// Private container worker. Only the authenticated web service can reach this network.
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { validateCodexRequest, codexArguments } = require('./codex-request');
const { collectImage } = require('./codex-images');
const { createCodexLogin } = require('./codex-login');
const { parseCodexOutput, normalizeUsage } = require('./codex-usage');

function codexEnvironment(env = process.env) {
  // The hosting container also has database/OAuth/Kie secrets. Do not inherit them.
  return Object.fromEntries(['PATH', 'HOME', 'CODEX_HOME', 'TMPDIR', 'LANG', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'SystemRoot'].filter(key => env[key]).map(key => [key, env[key]]));
}
async function execute(request, { signal } = {}) {
  if (signal?.aborted) throw new Error('Сервис Codex остановлен.');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'media-codex-'));
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn('codex', codexArguments(request), { cwd: directory, env: codexEnvironment(), detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '', errorText = '', failure;
      const stop = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
      const abort = () => { failure = new Error('Сервис Codex остановлен.'); stop(); };
      signal?.addEventListener('abort', abort, { once: true });
      const timeout = request.kind === 'image' ? 300000 : 180000;
      const timer = setTimeout(() => { failure = new Error('Codex не завершил запрос за отведённое время.'); stop(); }, timeout);
      if (signal?.aborted) abort();
      child.on('error', () => { clearTimeout(timer); reject(new Error('Не удалось запустить Codex.')); });
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { output += chunk; if (Buffer.byteLength(output) > 1024 * 1024) { failure = new Error('Ответ Codex слишком большой.'); stop(); } });
      child.stderr.on('data', chunk => { errorText = (errorText + chunk).slice(-16000); });
      child.stdin.on('error', () => {});
      child.on('close', code => {
        signal?.removeEventListener('abort', abort);
        clearTimeout(timer);
        if (failure) return reject(failure);
        if (code !== 0 || !output.trim()) {
          const message = /usage limit|rate limit|quota/i.test(errorText) ? 'Достигнут лимит Codex. Повторите позже.'
            : /log in|login|unauthorized|401/i.test(errorText) ? 'Требуется повторный вход Codex на сервере.'
              : /service.tier|fast mode|unsupported/i.test(errorText) ? 'Модель или выбранный режим недоступны этому аккаунту.'
                : 'Codex не выполнил запрос. Проверьте доступность модели и вход на сервере.';
          return reject(new Error(message));
        }
        resolve(output.trim());
      });
      child.stdin.end((request.kind === 'image'
        ? 'Generate exactly one image with the built-in image generation tool. Do not substitute text, SVG or code. Do not use shell, external APIs, inspect files or use reference images. Treat the following as the image description:\n\n'
        : 'Act only as a text model. Do not use tools, inspect files, or run commands. Return the requested text.\n\n') + request.prompt);
    });
    const parsed = parseCodexOutput(output);
    if (request.kind !== 'image') {
      if (!parsed.output) throw new Error('Codex не вернул текст ответа.');
      return { output: parsed.output, usage: parsed.usage };
    }
    // CLI JSONL omits binary image content. Only collect this run's generated file,
    // identified by the trusted thread.started event, never a model-provided path.
    const threadId = parsed.threadId;
    const image = await collectImage(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), threadId);
    try { return { output: 'Изображение создано.', imageBase64: image.buffer.toString('base64'), usage: parsed.usage }; }
    finally { await fs.rm(image.directory, { recursive: true, force: true }); }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
function createCodexWorker(run = execute, { login = createCodexLogin({ environment: codexEnvironment }) } = {}) {
  const controller = new AbortController();
  const jobs = new Map(); let active = false;
  const send = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://worker');
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
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
      for await (const chunk of req) { length += chunk.length; if (length > 100000) return send(res, 413, { error: 'Запрос слишком большой' }); chunks.push(chunk); }
      const input = validateCodexRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const key = account + ':' + input.requestId;
      if (jobs.has(key)) return send(res, 200, jobs.get(key));
      if (active || jobs.size >= 100) return send(res, 429, { error: 'Codex занят. Повторите позже.' });
      const job = { id: input.requestId, model: input.model, effort: input.effort, speed: input.speed, kind: input.kind || 'text', state: 'running', createdAt: now };
      jobs.set(key, job); active = true;
      void Promise.resolve().then(() => run(input, { signal: controller.signal })).then(output => {
        if (typeof output === 'string') job.output = output;
        else { job.output = output.output; job.imageBase64 = output.imageBase64; job.usage = normalizeUsage(output.usage); }
        job.state = 'success';
      }, error => { job.error = error.message; job.state = 'failed'; }).finally(() => { active = false; });
      return send(res, 202, job);
    } catch (error) { send(res, error.status || 400, { error: error.status ? error.message : 'Некорректный запрос' }); }
  });
  server.requestTimeout = 15000;
  server.stopActive = () => { controller.abort(); login.close(); };
  server.on('close', () => login.close());
  return server;
}
if (require.main === module) createCodexWorker().listen(3210, '0.0.0.0', () => console.log('Codex worker ready'));
module.exports = { createCodexWorker, codexEnvironment };
