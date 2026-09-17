const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');
const context = new AsyncLocalStorage();
const secrets = new Set();
let directory, sessionId, sequence = 0, warned = false;
const maxBytes = 5 * 1024 * 1024;
function secret(value) { if (typeof value === 'string' && value.length > 5) secrets.add(value); }
function clean(value, key = '', depth = 0) {
  if (/authorization|cookie|token|password|api.?key|secret/i.test(key)) return '[REDACTED]';
  if (value instanceof Error) return { name: value.name, message: clean(value.message), code: value.code, cause: value.cause ? clean(value.cause, '', depth + 1) : undefined };
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { bytes: value.byteLength };
  if (depth > 12) return '[DEPTH LIMIT]';
  if (typeof value === 'string') {
    // Embedded JSON (request bodies/resultJson) must be redacted structurally too.
    if (/^[\[{]/.test(value.trim())) { try { return clean(JSON.parse(value), '', depth + 1); } catch {} }
    for (const item of secrets) value = value.split(item).join('[REDACTED]');
    return value.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
      .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}/g, '[REDACTED]')
      .replace(/https?:\/\/[^\s"<>]+/g, address => { try { const url = new URL(address); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.href; } catch { return '[URL]'; } })
      .slice(0, 32768);
  }
  if (Array.isArray(value)) return value.slice(0, 100).map(item => clean(item, '', depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 100).map(([k,v]) => [k, clean(v,k,depth+1)]));
  return value;
}
function configure(folder) { directory = folder; sessionId = randomUUID(); write('session.start', { pid: process.pid, node: process.version }); }
function write(event, details = {}) {
  if (!directory) return;
  try {
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'generation.jsonl');
    const row = JSON.stringify({ time: new Date().toISOString(), sessionId, sequence: ++sequence, ...context.getStore(), event, details: clean(details) }) + '\n';
    if (fs.existsSync(file) && fs.statSync(file).size + Buffer.byteLength(row) > maxBytes) {
      const oldest = file + '.4'; if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
      for (let n = 3; n >= 1; n--) if (fs.existsSync(file + '.' + n)) fs.renameSync(file + '.' + n, file + '.' + (n + 1));
      fs.renameSync(file, file + '.1');
    }
    fs.appendFileSync(file, row, { mode: 0o600 });
  } catch { if (!warned) { warned = true; console.error('Не удалось записать журнал генерации. Проверьте доступ к каталогу логов.'); } }
}
function run(record, fn) { return context.run({ ...context.getStore(), requestId: record.traceRequestId || context.getStore()?.requestId, jobId: record.id, taskId: record.taskId || undefined, model: record.model || record.modelId }, fn); }
async function step(event, details, fn) {
  const started = Date.now(); write(event + '.start', details);
  try { const result = await fn(); write(event + '.success', { elapsedMs: Date.now() - started, result }); return result; }
  catch (error) { write(event + '.error', { elapsedMs: Date.now() - started, error }); throw error; }
}
async function tracedFetch(url, options = {}, fetcher = fetch) {
  if (!directory) return fetcher(url, options);
  const headers = new Headers(options.headers);
  const authorization = headers.get('authorization'); if (authorization) secret(authorization.replace(/^Bearer\s+/i, ''));
  const requestId = randomUUID(), started = Date.now();
  const body = options.body instanceof FormData ? Object.fromEntries([...options.body.entries()].map(([key,value]) => [key, typeof value === 'string' ? value : { name: value.name, size: value.size, type: value.type }])) : options.body;
  write('http.request', { requestId, url: String(url), method: options.method || 'GET', headers: Object.fromEntries(headers), body });
  try {
    const response = await fetcher(url, options);
    write('http.response', { requestId, status: response.status, elapsedMs: Date.now() - started, contentType: response.headers?.get('content-type') });
    if (response.clone && /json|text/.test(response.headers?.get('content-type') || '')) {
      const reader = response.clone().body?.getReader();
      if (reader) {
        const chunks = []; let size = 0, truncated = false;
        try {
          while (size < 65536) { const { done, value } = await reader.read(); if (done) break; chunks.push(Buffer.from(value).subarray(0, 65536 - size)); size += value.length; }
          truncated = size >= 65536;
        } catch { truncated = true; }
        finally { void reader.cancel().catch(() => {}); }
        write('http.body', { requestId, body: Buffer.concat(chunks).toString('utf8'), truncated });
      }
    }
    return response;
  } catch (error) { write('http.error', { requestId, elapsedMs: Date.now() - started, error }); throw error; }
}
function request(fn) { return context.run({requestId:randomUUID()},fn); }
module.exports = { request, current:()=>context.getStore(), configure, write, run, step, tracedFetch, secret, clean };
