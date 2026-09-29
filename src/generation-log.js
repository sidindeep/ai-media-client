const fs = require('node:fs/promises');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');
const aiLogger = require('./ai-logger');
const context = new AsyncLocalStorage();
const secrets = new Set();
let directory, sessionId, sequence = 0, warned = false;
const maxBytes = 5 * 1024 * 1024;
const retentionMs = 30 * 24 * 60 * 60 * 1000;
const maxPendingBytes = 4 * 1024 * 1024;
let pending = [], pendingBytes = 0, draining = null, dropped = 0;
let lastPruneDay = '';
let errorSink = null;
function setErrorSink(sink) { errorSink = sink; }
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
function configure(folder) { directory = folder; lastPruneDay = ''; sessionId = randomUUID(); write('session.start', { pid: process.pid, node: process.version }); }
async function logStart(file, stat) {
  const handle = await fs.open(file, 'r');
  try {
    const bytes = Buffer.alloc(256);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const timestamp = /"time":"([^"]+)"/.exec(bytes.subarray(0, bytesRead).toString('utf8'))?.[1];
    const parsed = Date.parse(timestamp || '');
    return Number.isFinite(parsed) ? parsed : stat.birthtimeMs || stat.mtimeMs;
  } finally { await handle.close(); }
}
async function pruneOldLogs(folder, now) {
  for (let n = 1; n <= 4; n++) {
    const file = path.join(folder, `generation.jsonl.${n}`);
    const stat = await fs.stat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat && now - await logStart(file, stat) >= retentionMs) await fs.rm(file);
  }
}
async function append(folder, row) {
  await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, 'generation.jsonl');
  const stat = await fs.stat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const now = Date.now();
  const rotate = stat && (stat.size + Buffer.byteLength(row) > maxBytes || now - await logStart(file, stat) >= retentionMs);
  if (rotate) {
    await fs.rm(file + '.4', { force: true });
    for (let n = 3; n >= 1; n--) {
      await fs.rename(file + '.' + n, file + '.' + (n + 1)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    await fs.rename(file, file + '.1').catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  await fs.appendFile(file, row, { mode: 0o600 });
  const day = new Date(now).toISOString().slice(0, 10);
  if (rotate || lastPruneDay !== day) { await pruneOldLogs(folder, now); lastPruneDay = day; }
}
function drain() {
  if (draining) return draining;
  draining = (async () => {
    while (pending.length) {
      const item = pending.shift();
      try { await append(item.folder, item.row); }
      catch { if (!warned) { warned = true; console.error('Не удалось записать журнал генерации. Проверьте доступ к каталогу логов.'); } }
      finally { pendingBytes -= item.bytes; }
    }
  })().finally(() => { draining = null; if (pending.length) drain(); });
  return draining;
}
function write(event, details = {}) {
  if (errorSink && /(?:^|\.)error$/.test(event)) {
    try { errorSink(event, details); } catch {}
  }
  if (!directory) return;
  try {
    const row = JSON.stringify({ time: new Date().toISOString(), sessionId, sequence: ++sequence, ...context.getStore(), event, details: clean(details) }) + '\n';
    const bytes = Buffer.byteLength(row);
    if (pendingBytes + bytes > maxPendingBytes) {
      dropped++;
      if (!warned) { warned = true; console.error('Очередь журнала генерации переполнена; диагностические события пропускаются.'); }
      return;
    }
    if (dropped) {
      const marker = JSON.stringify({ time: new Date().toISOString(), sessionId, sequence: ++sequence, event: 'journal.dropped', details: { count: dropped } }) + '\n';
      const markerBytes = Buffer.byteLength(marker);
      if (pendingBytes + bytes + markerBytes <= maxPendingBytes) { pending.push({ folder: directory, row: marker, bytes: markerBytes }); pendingBytes += markerBytes; dropped = 0; }
    }
    pending.push({ folder: directory, row, bytes }); pendingBytes += bytes;
    void drain();
    aiLogger.reportLifecycle(event);
  } catch { if (!warned) { warned = true; console.error('Не удалось записать журнал генерации. Проверьте доступ к каталогу логов.'); } }
}
function timing(event, details) {
  write(event, details);
  if (process.env.MEDIA_LOAD_TRACE === '1') console.log(JSON.stringify({ metric: event, ...details }));
}
async function flush() { while (draining || pending.length) await (draining || drain()); }
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
module.exports = { request, current:()=>context.getStore(), configure, write, timing, flush, run, step, tracedFetch, secret, clean, setErrorSink };
