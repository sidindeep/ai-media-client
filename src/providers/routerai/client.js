const BASE_URL = 'https://routerai.ru/api/v1';

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
      throw new Error(error?.name === 'TimeoutError' ? 'RouterAI не ответил вовремя' : 'RouterAI недоступен');
    }
    if (!response.ok) {
      const error = new Error(`RouterAI отклонил запрос (HTTP ${response.status})`);
      error.status = response.status;
      throw error;
    }
    try { return await response.json(); }
    catch { throw new Error('RouterAI вернул некорректный ответ'); }
  }

  return {
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
      } catch (error) { throw new Error(error?.name === 'TimeoutError' ? 'RouterAI не ответил вовремя' : 'RouterAI недоступен'); }
      if (!response.ok) throw Object.assign(new Error(`RouterAI отклонил запрос (HTTP ${response.status})`), { status: response.status });
      const type = response.headers.get('content-type') || '';
      if (type.includes('json')) return { type: 'json', data: await response.json() };
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
      }); } catch { throw new Error('RouterAI недоступен'); }
      if (!response.ok) throw Object.assign(new Error(`RouterAI отклонил запрос (HTTP ${response.status})`), { status: response.status });
      if (!content) return response.json();
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length || bytes.length > 64 * 1024 * 1024) throw new Error('Видео RouterAI слишком большое');
      return bytes;
    },
  };
}

module.exports = { createRouterAiClient };
