const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');
const aiLogger = require('./ai-logger');
const { clean, secret } = require('./ai-logger/diagnostics').sanitizer;
const { generationContext } = require('./ai-logger/generation-context.mjs');
const context = new AsyncLocalStorage();
let errorSink = null;
function setErrorSink(sink) { errorSink = sink; }
function configure() { write('session.start'); }
function write(event, details = {}) {
  try {
    if (/(?:^|\.)error$/.test(event)) {
      if (errorSink) errorSink(event, details);
      else aiLogger.reportSystemError({ source: 'diagnostic', event, error: details.error,
        code: details.error?.code || details.error?.providerCode || details.errorCode,
        generation: context.getStore()?.generation,
        diagnostic: require('./ai-logger/diagnostics').diagnostic('diagnostic', event, details.error,
          { ...(details.error?.providerMessage ? { description: details.error.providerMessage } : {}), ...details.diagnostic }) });
    }
  } catch { /* Diagnostics never change product behavior. */ }
}
function timing(event, details) { write(event, details); }
async function flush() { await aiLogger.flush(); }
function run(record, fn) {
  const scope = { ...context.getStore(), requestId: record.traceRequestId || context.getStore()?.requestId,
    jobId: record.id, taskId: record.taskId || undefined, model: record.model || record.modelId };
  Object.defineProperty(scope, 'generation', { value: generationContext(record, record.provider || 'kie') });
  return context.run(scope, fn);
}
async function step(event, details, fn) {
  write(event + '.start');
  try { const result = await fn(); write(event + '.success'); return result; }
  catch (error) { write(event + '.error', { error, diagnostic: details?.diagnostic }); throw error; }
}
async function tracedFetch(url, options = {}, fetcher = fetch) {
  const authorization = new Headers(options.headers).get('authorization');
  if (authorization) secret(authorization.replace(/^Bearer\s+/i, ''));
  write('http.request');
  try {
    const response = await fetcher(url, options);
    if (!response.ok) aiLogger.reportEvent('network', 'http.response.rejected', 'WARNING', `HTTP_${response.status}`);
    else write('http.response');
    return response;
  } catch (error) { write('http.error', { error }); throw error; }
}
function request(fn) { return context.run({ requestId: randomUUID() }, fn); }
module.exports = { request, current: () => context.getStore(), configure, write, timing, flush, run, step, tracedFetch, secret, clean, setErrorSink };
