const BASE_URL = 'https://routerai.ru/api/v1';
const { parseRetryAfter } = require('../../retry-after');
const { providerFailure, safeMessage } = require('../../provider-diagnostics');

async function rejected(response, fallback) {
  let body;
  try {
    // Parse only structured error fields. Arbitrary HTML and plaintext may
    // contain proxy headers, credentials or request payloads.
    if (typeof response.text === 'function') body = await response.text();
    else if (typeof response.json === 'function') body = await response.json();
  } catch { /* HTTP status remains useful even if the body is unreadable. */ }
  const failure = providerFailure(body, { provider: 'RouterAI', status: response.status, fallback });
  return Object.assign(new Error(failure.message), { status: response.status, providerCode: failure.providerCode,
    providerMessage: failure.providerMessage, retryAfterMs: parseRetryAfter(response.headers?.get?.('retry-after')) });
}

function connectionError(error) {
  return new Error(error?.name === 'TimeoutError' ? 'RouterAI не ответил вовремя'
    : `RouterAI: ${safeMessage(error?.message) || 'Ошибка соединения'}`);
}

function providerPayload(payload) {
  if (payload?.error) {
    const failure = providerFailure(payload, { provider: 'RouterAI' });
    throw Object.assign(new Error(failure.message), { confirmedRejected: true,
      providerCode: failure.providerCode, providerMessage: failure.providerMessage });
  }
  return payload;
}

function createRouterAiClient({ apiKey, fetchImpl = fetch, timeoutMs = 120000 } = {}) {
  if (!apiKey) throw new Error('ROUTERAI_API_KEY не настроен');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw new Error('Некорректный таймаут RouterAI');

  async function request(path, body) {
    let response;
    try {
      response = await fetchImpl(BASE_URL + path, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw connectionError(error);
    }
    if (!response.ok) {
      throw await rejected(response);
    }
    let payload;
    try { payload = await response.json(); }
    catch { throw new Error('RouterAI вернул некорректный ответ'); }
    return providerPayload(payload);
  }

  return {
    async credits() {
      let response;
      try {
        response = await fetchImpl(`${BASE_URL}/credits`, {
          headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(Math.min(timeoutMs, 15000)),
        });
      } catch (error) { throw connectionError(error); }
      if (!response.ok) throw await rejected(response, `Не удалось проверить баланс RouterAI (HTTP ${response.status})`);
      let payload;
      try { payload = await response.json(); } catch { throw new Error('RouterAI вернул некорректный баланс'); }
      payload = providerPayload(payload);
      const value = payload?.data?.credits ?? payload?.credits;
      if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value))) throw new Error('RouterAI не вернул остаток баланса');
      const credits = Number(value);
      if (!Number.isFinite(credits) || credits < 0) throw new Error('RouterAI не вернул остаток баланса');
      return credits;
    },
    chatCompletion: ({ model, messages, ...options }) => request('/chat/completions', { model, messages, ...options }),
    generateImage: ({ model, prompt, ...options }) => request('/images', { model, prompt, ...options }),
    async raw(endpoint, body) {
      const allowed = new Set(['chat/completions', 'images', 'videos', 'audio/speech', 'audio/transcriptions', 'embeddings', 'rerank', 'decisions']);
      if (!allowed.has(endpoint)) throw new Error('Неподдерживаемый метод RouterAI');
      let response;
      try {
        response = await fetchImpl(`${BASE_URL}/${endpoint}`, {
          method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) { throw connectionError(error); }
      if (!response.ok) throw await rejected(response);
      const type = response.headers.get('content-type') || '';
      if (type.includes('json')) return { type: 'json', data: providerPayload(await response.json()) };
      if (type.includes('text/event-stream')) return { type: 'text', data: await response.text() };
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 64 * 1024 * 1024) throw new Error('Ответ RouterAI слишком большой');
      return { type: 'binary', mime: type.split(';')[0].toLowerCase(), data: bytes };
    },
    async video(id, content = false) {
      if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(id)) throw new Error('Некорректный ID видео RouterAI');
      let response;
      try { response = await fetchImpl(`${BASE_URL}/videos/${encodeURIComponent(id)}${content ? '/content' : ''}`, {
        headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(timeoutMs),
      }); } catch (error) { throw connectionError(error); }
      if (!response.ok) throw await rejected(response);
      if (!content) return response.json();
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length || bytes.length > 64 * 1024 * 1024) throw new Error('Видео RouterAI слишком большое');
      return bytes;
    },
  };
}

module.exports = { createRouterAiClient };
