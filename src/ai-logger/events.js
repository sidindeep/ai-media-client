const generationEvents = new Set(['generation.started', 'generation.completed']);
function eventEnabled(source, event, level = 'INFO') {
  const selected = String(level).toUpperCase();
  return selected === 'INFO' ? source === 'generation' && generationEvents.has(event)
    : ['WARNING', 'ERROR', 'CRITICAL'].includes(selected);
}
function generationMetadata(provider, record = {}) {
  const context = {};
  if (['kie', 'codex', 'routerai', 'apimart'].includes(provider)) context.provider = provider;
  for (const [key, value] of [['job_id', record.id], ['request_id', record.requestId || record.traceRequestId]]) {
    if (typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value)) context[key] = value;
  }
  if (['submitting', 'running', 'success', 'fail', 'failed', 'cancelled'].includes(record.state)) context.status = record.state;
  return context;
}
module.exports = { eventEnabled, generationMetadata };
