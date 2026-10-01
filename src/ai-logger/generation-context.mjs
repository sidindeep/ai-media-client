const CONTENT = /^content:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;
const LEGACY = /^https:\/\/local-assets\.invalid\/([a-f0-9]{64})$/;

function sourceUrl(value, origin) {
  if (typeof value !== 'string') return null;
  const asset = CONTENT.exec(value);
  if (asset) return `${origin}/api/content/${asset[1]}`;
  const legacy = LEGACY.exec(value);
  if (legacy) return `${origin}/api/sources/${legacy[1]}`;
  if (!/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return url.href;
  } catch { return null; }
}

export function generationContext(record = {}, provider, publicOrigin = process.env.MEDIA_PUBLIC_ORIGIN || '') {
  let origin = '';
  try { const url = new URL(publicOrigin); if (['http:', 'https:'].includes(url.protocol)) origin = url.origin; } catch {}
  const sourceUrls = new Set();
  function visit(value, media = false, depth = 0) {
    if (depth > 12 || sourceUrls.size >= 100) return;
    if (typeof value === 'string') {
      if (media || CONTENT.test(value) || LEGACY.test(value)) {
        const url = sourceUrl(value, origin);
        if (url) sourceUrls.add(url);
      }
    } else if (Array.isArray(value)) value.slice(0, 100).forEach(item => visit(item, media, depth + 1));
    else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value).slice(0, 100)) {
        if (/prompt|token|secret|password|authorization|cookie|api.?key/i.test(key)) continue;
        visit(item, media || /image|photo|source|reference|^ref$|^url$/i.test(key), depth + 1);
      }
    }
  }
  visit(record.sourceFiles, true);
  visit(record.input); visit(record.parameters); visit(record.payload);
  return { prompt: record.prompt ?? record.input?.prompt ?? record.payload?.prompt ?? '',
    source_urls: [...sourceUrls], provider, model: record.model || record.modelId,
    job_id: record.requestId || record.id, request_id: record.traceRequestId || record.requestId };
}

export function sanitizeGenerationContext(value, sanitizer) {
  if (!value || typeof value !== 'object') return {};
  const result = {};
  if (typeof value.prompt === 'string') result.prompt = sanitizer.prompt(value.prompt);
  if (Array.isArray(value.source_urls)) result.source_urls = [...new Set(value.source_urls
    .slice(0, 100).map(url => sourceUrl(url, '')).filter(Boolean)
    .map(url => sanitizer.text(url).slice(0, 2048)))];
  // Relative owner-protected content links are valid when no public origin is configured.
  if (Array.isArray(value.source_urls)) {
    for (const url of value.source_urls.slice(0, 100)) {
      if (typeof url === 'string' && /^\/api\/(?:content\/[a-f0-9-]{36}|sources\/[a-f0-9]{64})$/i.test(url)) result.source_urls.push(url);
    }
    result.source_urls = [...new Set(result.source_urls)];
  }
  for (const key of ['provider', 'model', 'job_id', 'request_id']) {
    if (typeof value[key] === 'string') result[key] = sanitizer.text(value[key]).slice(0, 200);
  }
  return result;
}
