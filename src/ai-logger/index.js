const { sanitizer } = require('./diagnostics');
const { AiLoggerClient } = require('./client.mjs');
const { createSystemErrorRecorder, createHttpSystemErrorSink } = require('./system-errors.mjs');
function createForwarder({ env = process.env, fetchImpl = fetch, retryMs = 5000, maxPending = 100 } = {}) {
  if (!env.AI_LOGGER_SERVER_URL) return null;
  let client;
  try {
    client = new AiLoggerClient({
      serverUrl: env.AI_LOGGER_SERVER_URL, project: env.AI_LOGGER_PROJECT,
      service: env.AI_LOGGER_SERVICE || env.MEDIA_REPLICA_ROLE || 'web',
      environment: env.AI_LOGGER_ENVIRONMENT || 'production',
      instanceId: env.AI_LOGGER_INSTANCE_ID,
      fallbackJsonlPath: env.AI_LOGGER_FALLBACK_JSONL_PATH || null,
      timeoutMs: 1500, allowPrivateHttp: env.AI_LOGGER_ALLOW_PRIVATE_HTTP === '1', fetchImpl,
    });
  } catch {
    console.warn('ai_logger: check AI_LOGGER_SERVER_URL and AI_LOGGER_PROJECT');
    return null;
  }
  const errorSink = createHttpSystemErrorSink(client);
  const recorder = createSystemErrorRecorder({ sanitizer, maxPending, retryMs, maxDrainMs: 5000, sink: row =>
    row.details.level === 'INFO' || row.details.level === 'WARNING'
      ? client.send({ level: row.details.level, logger: `${client.project}.${row.source}`,
        message: /^[A-Za-z0-9_.:-]{1,150}$/.test(row.event) ? row.event : 'diagnostic.event',
        context: { source: row.source, error_code: row.code || 'unknown' } })
      : errorSink(row),
  });
  return {
    lifecycle(event) { return recorder.record('diagnostic', event, event, { level: 'INFO' }); },
    event(source, event, level = 'INFO', code) { return recorder.record(source, event, { code }, { level }); },
    systemError(row) { return recorder.record(row.source, row.event, row.error || { code: row.code },
      { code: row.code, diagnostic: row.diagnostic, exception: row.exception || row.diagnostic?.exception }); },
    flush: recorder.flush, close: recorder.close, status: recorder.status,
  };
}
const forwarder = createForwarder();
function reportLifecycle(event) { try { return forwarder?.lifecycle(event) || false; } catch { return false; } }
function reportEvent(source, event, level, code) { try { return forwarder?.event(source, event, level, code) || false; } catch { return false; } }
function reportSystemError(row) { try { return forwarder?.systemError(row) || false; } catch { return false; } }
async function flush() { await forwarder?.flush(); }
async function close() { await flush(); return forwarder?.close(); }
module.exports = { createForwarder, reportLifecycle, reportEvent, reportSystemError, flush, close };
