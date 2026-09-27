const trace = require('./generation-log');

// Errors cross the worker, database, history API and UI. Keep the same bounded
// explanation at each boundary, without copying request bodies or raw responses.
function safeMessage(value) {
  if (typeof value !== 'string') return '';
  return String(trace.clean(value.slice(0, 16000)))
    .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|authorization|cookie)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/data:[^\s,]*;base64,[A-Za-z0-9+/=]+/g, '[image data]')
    .replace(/[A-Za-z0-9+/=]{256,}/g, '[binary data]')
    .slice(0, 3000).trim();
}

function code(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  return safeMessage(String(value)).slice(0, 100) || null;
}

function providerFailure(payload, { provider, status, fallback } = {}) {
  let value = payload;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { value = null; }
  }
  const issue = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const data = issue.data && typeof issue.data === 'object' && !Array.isArray(issue.data) ? issue.data : {};
  const nestedError = issue.error ?? data.error;
  const nested = nestedError && typeof nestedError === 'object' && !Array.isArray(nestedError) ? nestedError : {};
  const providerCode = code(nested.code ?? issue.code ?? data.code ?? nested.type ?? issue.type);
  const raw = [nested.message, issue.message, data.message, issue.detail, data.detail, issue.error_description,
    issue.failure_reason, data.failure_reason, issue.fail_reason, data.fail_reason,
    issue.failMsg, data.failMsg, typeof nestedError === 'string' ? nestedError : null]
    .find(item => typeof item === 'string' && item.trim());
  const message = safeMessage(raw || '') || fallback || `${provider || 'Provider'} returned HTTP ${status || 'error'}`;
  const parts = [provider || 'Provider'];
  if (status) parts.push(`HTTP ${status}`);
  if (providerCode) parts.push(providerCode);
  return { providerCode: providerCode || (status ? String(status) : null), providerMessage: message,
    message: `${parts.join(' · ')}: ${message}`.slice(0, 4000), httpStatus: status ?? null };
}

function recordFailure(record, provider) {
  const info = record.errorInfo || {};
  const providerCode = code(info.providerCode ?? record.failCode ?? record.errorCode ?? record.failureCode);
  const providerMessage = safeMessage(info.providerMessage || record.failMsg || record.statusError || '');
  const base = safeMessage(record.error || info.message || '');
  const parts = [base];
  if (providerCode && !base.includes(providerCode)) parts.push(`Код: ${providerCode}`);
  if (providerMessage && !base.includes(providerMessage)) parts.push(`Детали ${provider}: ${providerMessage}`);
  return { code: providerCode, message: parts.filter(Boolean).join(' · ').slice(0, 4000) };
}

module.exports = { safeMessage, providerFailure, recordFailure };
