const BASE_URL = 'https://api.apimart.ai/v1';
const { providerFailure, safeMessage } = require('../../provider-diagnostics');

function createApimartClient({ apiKey, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error('APIMART_API_KEY не настроен');
  require('../../ai-logger/diagnostics').sanitizer.secret(apiKey);
  async function request(path, init = {}) {
    let response;
    try {
      response = await fetchImpl(path.startsWith('https://') ? path : `${BASE_URL}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${apiKey}`, ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) },
        signal: init.signal || AbortSignal.timeout(120000),
      });
    } catch (error) {
      require('../../system-errors').record('provider', 'apimart.connection.error', error,
        { diagnostic: { description: 'Не удалось подключиться к APIMart', entity: 'provider' } });
      throw new Error(`APIMart: ${safeMessage(error?.message) || 'Ошибка соединения'}`);
    }
    if (!response.ok) {
      let body = null;
      try { body = await response.json(); } catch { /* HTTP status is enough. */ }
      const failure = providerFailure(body, { provider: 'APIMart', status: response.status });
      throw Object.assign(new Error(failure.message), { status: response.status, confirmedRejected: true });
    }
    let payload;
    try { payload = await response.json(); } catch { throw new Error('APIMart вернул некорректный JSON'); }
    if (payload?.error || payload?.success === false) {
      const failure = providerFailure(payload, { provider: 'APIMart' });
      throw Object.assign(new Error(failure.message), { confirmedRejected: true });
    }
    return payload;
  }
  async function speech(payload) {
    const response = await fetchImpl(`${BASE_URL}/audio/speech`, {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) {
      let body = null;
      try { body = await response.json(); } catch { /* status is enough */ }
      const failure = providerFailure(body, { provider: 'APIMart', status: response.status });
      throw Object.assign(new Error(failure.message), { status: response.status, confirmedRejected: true });
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 50 * 1024 * 1024) throw new Error('APIMart вернул пустой или слишком большой аудиофайл');
    return bytes;
  }
  return {
    models: () => request('/models?expand=category'),
    balance: () => request('/user/balance', { signal: AbortSignal.timeout(10000) }),
    pricing: model => request(`https://api.apimart.ai/api/pricing/model?${new URLSearchParams({ model })}`,
      { signal: AbortSignal.timeout(10000) }),
    chat: (model, prompt) => request('/chat/completions', {
      method: 'POST', body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: false }),
    }),
    text: (model, prompt, endpoint = '/v1/chat/completions') => {
      const bodies = {
        '/v1/chat/completions': { model, messages: [{ role: 'user', content: prompt }], stream: false },
        '/v1/responses': { model, input: prompt, stream: false },
        '/v1/completions': { model, prompt, max_tokens: 512, stream: false },
        '/v1/edits': { model, instruction: prompt, input: '' },
      };
      if (!bodies[endpoint]) throw new Error('Неизвестный текстовый API APIMart');
      return request(endpoint.slice(3), { method: 'POST', body: JSON.stringify(bodies[endpoint]) });
    },
    audioChat: (model, prompt, options = {}) => request('/chat/completions', {
      method: 'POST', body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }],
        modalities: ['text', 'audio'], audio: { voice: options.voice || 'alloy', format: 'wav' }, stream: false }),
    }),
    speech,
    uploadImage: (bytes, filename, type) => {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type }), filename);
      return request('/uploads/images', { method: 'POST', body: form, signal: AbortSignal.timeout(120000) });
    },
    transcribe: (model, bytes, filename, options = {}) => {
      const form = new FormData();
      form.append('file', new Blob([bytes]), filename);
      form.append('model', model);
      form.append('response_format', 'json');
      if (typeof options.language === 'string' && options.language) form.append('language', options.language);
      return request('/audio/transcriptions', { method: 'POST', body: form });
    },
    generate: (endpoint, payload) => {
      if (!['/v1/images/generations', '/v1/videos/generations', '/v1/music/generations', '/v1/midjourney/generations'].includes(endpoint)) {
        throw new Error('Неизвестный API генерации APIMart');
      }
      return request(endpoint.slice(3), { method: 'POST', body: JSON.stringify(payload) });
    },
    task: (taskId, kind) => request(`${kind === 'audio' ? '/music/tasks' : '/tasks'}/${encodeURIComponent(taskId)}`, {
      signal: AbortSignal.timeout(20000),
    }),
  };
}

module.exports = { createApimartClient };
