const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { codexEnvironment } = require('./codex-runtime');
const { codexPrompt, disabledFeatures, imageFeatures } = require('./codex-request');
const { collectImage, validatePng } = require('./codex-images');
const { normalizeUsage } = require('./codex-usage');

const uncertain = () => Object.assign(new Error('Связь с Codex app-server потеряна. Результат неизвестен; автоматический повтор отключён.'), { outcomeUnknown: true });
const failure = () => new Error('Codex app-server не выполнил запрос. Проверьте модель и вход на сервере.');
function threadParams(request, cwd) {
  return {
    model: request.model, cwd, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only',
    serviceTier: request.speed === 'fast' ? 'fast' : 'default',
    config: {
      project_doc_max_bytes: 0, web_search: 'disabled', model_reasoning_effort: request.effort,
      'features.fast_mode': request.speed === 'fast',
      ...Object.fromEntries(disabledFeatures.map(name => [`features.${name}`, false])),
      ...Object.fromEntries(imageFeatures.map(name => [`features.${name}`, request.kind === 'image'])),
    },
  };
}

// One stdio connection multiplexes isolated ephemeral threads. No generation replay.
function createCodexAppServer({ launch = spawn, environment = codexEnvironment,
  rpcTimeoutMs = Number(process.env.MEDIA_CODEX_RPC_TIMEOUT_MS || 60000), textTimeoutMs = 180000, imageTimeoutMs = 300000,
  collect = collectImage, diagnostic = event => console.warn(JSON.stringify({ component: 'codex-app-server', ...event })) } = {}) {
  if (!Number.isSafeInteger(rpcTimeoutMs) || rpcTimeoutMs < 1) throw new Error('Invalid MEDIA_CODEX_RPC_TIMEOUT_MS');
  const report = event => { try { diagnostic(event); } catch {} };
  let session, starting, closed = false;
  const runs = new Set();
  async function start() {
    if (closed) throw uncertain();
    if (starting) return starting;
    if (session && !session.dead) return session;
    starting = (async () => {
      const env = environment();
      const home = env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex');
      // Unlike exec, 0.155.0 app-server has no --ignore-user-config. Fail closed
      // rather than inherit arbitrary MCP servers, profiles or credential overrides.
      if (await fs.access(path.join(home, 'config.toml')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) {
        throw new Error('Для app-server нужен CODEX_HOME без пользовательского config.toml. Используйте exec или отдельное хранилище авторизации.');
      }
      const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'media-app-server-'));
      if (closed) { await fs.rm(cwd, { recursive: true, force: true }); throw uncertain(); }
      const args = ['app-server', '--listen', 'stdio://', '-c', 'project_doc_max_bytes=0',
        '-c', 'web_search="disabled"', ...disabledFeatures.flatMap(name => ['--disable', name])];
      let child;
      try { child = launch('codex', args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
      catch { await fs.rm(cwd, { recursive: true, force: true }); throw failure(); }
      const current = { child, cwd, home, pending: new Map(), late: new Map(), threads: new Map(), id: 0, dead: false };
      session = current;
      let buffer = '';
      current.break = (reason = 'transport_failure') => {
        if (current.dead) return;
        report({ event: 'process_stop', reason, pending: current.pending.size, active: current.threads.size });
        current.dead = true;
        for (const request of current.pending.values()) { clearTimeout(request.timer); request.reject(uncertain()); }
        current.pending.clear();
        for (const entry of current.late.values()) clearTimeout(entry.timer);
        current.late.clear();
        for (const job of current.threads.values()) job.reject(uncertain());
        current.threads.clear();
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      };
      current.send = value => {
        if (current.dead) throw uncertain();
        child.stdin.write(JSON.stringify(value) + '\n');
      };
      current.rpc = (method, params, onLate) => new Promise((resolve, reject) => {
        if (current.dead) return reject(uncertain());
        const id = ++current.id;
        const timer = setTimeout(() => {
          current.pending.delete(id);
          report({ event: 'rpc_timeout', method, timeoutMs: rpcTimeoutMs });
          if (onLate) {
            // Bounded retention for cancelling a turn acknowledged after its caller left.
            if (current.late.size >= 1024) {
              const oldest = current.late.keys().next().value;
              clearTimeout(current.late.get(oldest).timer); current.late.delete(oldest);
            }
            const expiry = setTimeout(() => current.late.delete(id), Math.max(textTimeoutMs, imageTimeoutMs));
            expiry.unref(); current.late.set(id, { callback: onLate, timer: expiry });
          }
          reject(uncertain());
        }, rpcTimeoutMs);
        current.pending.set(id, { resolve, reject, timer });
        try { current.send({ id, method, params }); } catch { current.break('stdin_write'); }
      });
      child.stdin.on('error', () => current.break('stdin_error'));
      child.once('error', () => current.break('spawn_error'));
      child.once('close', (code, signal) => {
        report({ event: 'process_exit', code, signal });
        current.break('process_exit');
        void fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
      });
      // Drain diagnostics without returning raw provider output or credentials.
      child.stderr.on('data', () => {});
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        buffer += chunk;
        // An image item can contain a 16 MiB PNG encoded as Base64.
        if (Buffer.byteLength(buffer) > 32 * 1024 * 1024) return current.break('stdout_limit');
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          if (!line.trim()) continue;
          let message;
          try { message = JSON.parse(line); } catch { current.break('invalid_json'); return; }
          if (message.id !== undefined && message.method) {
            // This adapter never grants tools, interactive input or extra permissions.
            try { current.send({ id: message.id, error: { code: -32601, message: 'Interactive requests are disabled' } }); }
            catch { current.break(); }
            continue;
          }
          if (message.id !== undefined) {
            const pending = current.pending.get(message.id);
            if (!pending) {
              const late = current.late.get(message.id);
              if (late) {
                current.late.delete(message.id); clearTimeout(late.timer);
                if (!message.error) void Promise.resolve().then(() => late.callback(message.result)).catch(() => {});
              }
              continue;
            }
            current.pending.delete(message.id); clearTimeout(pending.timer);
            if (message.error) pending.reject(failure()); else pending.resolve(message.result);
            continue;
          }
          const params = message.params || {};
          const job = current.threads.get(params.threadId);
          if (!job) continue;
          const turnId = params.turnId || params.turn?.id;
          if (job.turnId && turnId && job.turnId !== turnId) continue;
          if (turnId) job.turnId = turnId;
          if (message.method === 'thread/tokenUsage/updated') {
            const value = params.tokenUsage?.total;
            job.usage = normalizeUsage(value && { input_tokens: value.inputTokens, output_tokens: value.outputTokens,
              cached_input_tokens: value.cachedInputTokens, reasoning_output_tokens: value.reasoningOutputTokens });
          }
          if (message.method === 'item/completed' && params.item?.type === 'agentMessage') {
            job.messages.set(params.item.id, params.item.text || '');
            if (Buffer.byteLength([...job.messages.values()].join('\n')) > 1024 * 1024) {
              job.reject(uncertain());
            }
          }
          if (message.method === 'item/completed' && params.item?.type === 'imageGeneration'
            && typeof params.item.result === 'string') {
            try {
              job.imageBuffer = validatePng(Buffer.from(params.item.result, 'base64'));
            } catch (error) {
              job.reject(error);
            }
          }
          if (message.method === 'turn/completed') {
            if (params.turn?.status === 'completed') job.resolve();
            else job.reject(failure());
          }
        }
      });
      try {
        await current.rpc('initialize', { clientInfo: { name: 'ai_media_client', version: '1.0.0' } });
        current.send({ method: 'initialized', params: {} });
        return current;
      } catch (error) { current.break('initialize_failed'); throw error; }
    })();
    try { return await starting; } finally { starting = null; }
  }

  async function run(request, { signal } = {}) {
    if (signal?.aborted || closed) throw uncertain();
    let current, threadId, job, timer, aborted = false, completed = false;
    let rejectStop;
    const stopped = new Promise((resolve, reject) => { rejectStop = reject; });
    const abort = () => { aborted = true; rejectStop(uncertain()); };
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(abort, request.kind === 'image' ? imageTimeoutMs : textTimeoutMs);
    const operation = (async () => {
      current = await start();
      if (aborted || signal?.aborted) throw uncertain();
      const response = await current.rpc('thread/start', threadParams(request, current.cwd), reply => {
        const id = reply?.thread?.id;
        if (typeof id === 'string') return current.rpc('thread/unsubscribe', { threadId: id });
      });
      threadId = response?.thread?.id;
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(threadId || '')) throw failure();
      // An abort during thread/start must not start a generation after the caller left.
      if (aborted || signal?.aborted) { await current.rpc('thread/unsubscribe', { threadId }); throw uncertain(); }
      const done = new Promise((resolve, reject) => {
        job = { resolve, reject, messages: new Map(), usage: null, imageBuffer: null, turnId: null };
        current.threads.set(threadId, job);
      });
      // Notifications may arrive before the turn/start response.
      const stopLateTurn = async reply => {
        const id = reply?.turn?.id;
        if (id) await current.rpc('turn/interrupt', { threadId, turnId: id }).catch(() => {});
        await current.rpc('thread/unsubscribe', { threadId }).catch(() => {});
      };
      const input = [{ type: 'text', text: codexPrompt(request) }, ...(request.images || []).map(url => ({ type: 'image', url }))];
      const turn = current.rpc('turn/start', { threadId, input,
        effort: request.effort, serviceTier: request.speed === 'fast' ? 'fast' : 'default' }, stopLateTurn)
        .then(async reply => {
          job.turnId = reply?.turn?.id || job.turnId;
          if (aborted) { await stopLateTurn(reply); throw uncertain(); }
          return reply;
        });
      const [reply] = await Promise.all([turn, done]);
      completed = true;
      job.turnId = reply?.turn?.id || job.turnId;
      if (request.kind !== 'image') {
        const output = [...job.messages.values()].join('\n\n').trim();
        if (!output) throw new Error('Codex не вернул текст ответа.');
        return { output, usage: job.usage };
      }
      if (job.imageBuffer) {
        return { output: 'Изображение создано.', imageBase64: job.imageBuffer.toString('base64'), usage: job.usage };
      }
      // Older Codex releases write the result to a trusted thread directory.
      const image = await collect(current.home, threadId);
      try { return { output: 'Изображение создано.', imageBase64: image.buffer.toString('base64'), usage: job.usage }; }
      finally { await fs.rm(image.directory, { recursive: true, force: true }); }
    })();
    runs.add(operation);
    try { return await Promise.race([operation, stopped]); }
    finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      runs.delete(operation);
      if (current && threadId) {
        if (!completed && job?.turnId && !current.dead) {
          await current.rpc('turn/interrupt', { threadId, turnId: job.turnId }).catch(() => {});
        }
        // Reject the internal waiter as well: a timed-out caller must not leak it.
        job?.reject(uncertain()); current.threads.delete(threadId);
        if (!current.dead) await current.rpc('thread/unsubscribe', { threadId }).catch(() => {});
      }
    }
  }
  return { run, async rateLimits() {
      const current = await start();
      return current.rpc('account/rateLimits/read', {});
    }, close() { closed = true; session?.break('shutdown'); },
    status() { return { transport: 'app-server', running: Boolean(session && !session.dead), active: runs.size }; } };
}
module.exports = { createCodexAppServer, threadParams };
