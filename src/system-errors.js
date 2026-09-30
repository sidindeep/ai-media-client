const aiLogger = require('./ai-logger');
const { sanitizer: { clean }, diagnostic } = require('./ai-logger/diagnostics');
function record(source, event, error, details = {}) {
  try { return aiLogger.reportSystemError({ source: clean(String(source)), event: clean(String(event)), code: clean(error)?.code ?? clean(error?.providerCode) ?? clean(error?.status),
    error, diagnostic: diagnostic(source, event, error, details.diagnostic) }); }
  catch { return false; }
}
function captureConsole(target = console) {
  const original = target.error;
  function captured(...args) {
    original.apply(target, args);
    const error = args.find(value => value instanceof Error);
    record('server', 'console.error', error);
  }
  target.error = captured;
  return () => { if (target.error === captured) target.error = original; };
}
async function step(source, event, action) {
  aiLogger.reportEvent(source, event + '.start');
  try { const result = await action(); aiLogger.reportEvent(source, event + '.success'); return result; }
  catch (error) { record(source, event + '.error', error); throw error; }
}
module.exports = { record, flush: aiLogger.flush, captureConsole, step };
