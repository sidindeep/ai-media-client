/** Portable diagnostic sanitizer extracted from ai-media-client's generation journal. */
export function createSanitizer() {
  const secrets = new Set();
  function secret(value) {
    if (typeof value === 'string' && value.length > 5) secrets.add(value);
  }
  function clean(value, key = '', depth = 0) {
    if (/authorization|cookie|token|password|api.?key|secret|prompt|account.?id|email/i.test(key)) return '[REDACTED]';
    if (depth > 12) return '[DEPTH LIMIT]';
    if (value instanceof Error) return {
      name: clean(value.name, '', depth + 1), message: text(value.message),
      code: clean(value.code, '', depth + 1),
      stack: value.stack == null ? undefined : text(value.stack),
      cause: value.cause ? clean(value.cause, '', depth + 1) : undefined,
    };
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { bytes: value.byteLength };
    if (typeof value === 'string') {
      if (/^[\[{]/.test(value.trim())) {
        try { return clean(JSON.parse(value), '', depth + 1); } catch { /* ordinary text */ }
      }
      return scrub(value);
    }
    if (Array.isArray(value)) return value.slice(0, 100).map(item => clean(item, '', depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(
      Object.entries(value).slice(0, 100).map(([k, v]) => [k, clean(v, k, depth + 1)]),
    );
    return typeof value === 'bigint' ? String(value) : value;
  }
  function scrub(value, allowPrompt = false) {
    for (const item of secrets) value = value.split(item).join('[REDACTED]');
    // Avoid quadratic email matching on long unbroken prompt text without an @.
    if (value.includes('@')) value = value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED EMAIL]');
    return value.replace(/(?:https?|postgres(?:ql)?):\/\/[^\s"<>]+/g, address => {
          try {
            const url = new URL(address);
            url.username = ''; url.password = ''; url.search = ''; url.hash = '';
            return url.href;
          } catch { return '[URL]'; }
        })
        .replace(/\{[^\n]*\}|\[[^\n]*\]/g, payload => {
          if (allowPrompt) return payload;
          try { const parsed = JSON.parse(payload); return parsed && typeof parsed === 'object' ? '[REDACTED PAYLOAD]' : payload; } catch { return payload; }
        })
        .replace(/(cookie\s*[:=]\s*)[^\n]+/gi, '$1[REDACTED]')
        .replace(allowPrompt
          ? /(["']?(?:cookie|account[_-]?id|email|authorization|api[_-]?key|password|token|secret)["']?\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\n;,}]+)/gi
          : /((?:prompt|cookie|account[_-]?id|email|authorization|api[_-]?key|password|token|secret)\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\n;]+)/gi, '$1[REDACTED]')
        .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
        .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]+/g, '[REDACTED]')
        .replace(/data:[^\s,]*;base64,[A-Za-z0-9+/=]+/g, '[image data]')
        .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}/g, '[REDACTED]')
        .replace(/((?:api[_-]?key|password|token|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
        .slice(0, 32768);
  }
  function text(value) { const safe = clean(value); return typeof safe === 'object' && safe !== null ? '[REDACTED PAYLOAD]' : String(safe ?? ''); }
  // Only the explicit generation-error contract permits prompt prose/JSON.
  const prompt = value => typeof value === 'string' ? scrub(value, true) : '';
  return { clean, secret, text, prompt };
}
