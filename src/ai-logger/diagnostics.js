const { createSanitizer } = require('./sanitize.mjs');
const sanitizer = createSanitizer();
// Register configured secrets once, including URL credentials, before any startup capture.
for (const [key, value] of Object.entries(process.env)) {
  if (/token|password|secret|api.?key|database_url|authorization|cookie/i.test(key)) {
    sanitizer.secret(value);
    try { const url = new URL(value); sanitizer.secret(decodeURIComponent(url.password)); } catch {}
  }
}
function diagnostic(source, event, error, selected = {}) {
  const entity = event.startsWith('task.') ? 'task' : event === 'config.error' ? 'configuration'
    : source === 'diagnostic' ? event.split('.')[0] : source;
  const result = { description: 'Ошибка при выполнении ' + source + ': ' + event, entity };
  if (typeof error?.stack === 'string') {
    // Match an actual V8 frame, never the message or a newly created logging stack.
    for (const frame of error.stack.split('\n').slice(1)) {
      const match = frame.match(/^\s*at (?:(.*?) \()?(.+?):(\d+):(\d+)\)?$/);
      if (!match) continue;
      result.file = match[2]; result.line = Number(match[3]);
      if (match[1]) result.function = match[1];
      break;
    }
  }
  for (const key of ['description', 'file', 'line', 'function', 'entity']) {
    if (typeof selected[key] === 'string' || typeof selected[key] === 'number') result[key] = selected[key];
  }
  return sanitizer.clean(result);
}
module.exports = { sanitizer, diagnostic };
