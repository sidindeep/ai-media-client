const BASE_URL = 'https://api.apimart.ai/v1';
const { providerFailure, safeMessage } = require('../../provider-diagnostics');

function createApimartClient({ apiKey, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error('APIMART_API_KEY не настроен');
  async function request(path, init = {}) {
    let response;
    try {
      response = await fetchImpl(`${BASE_URL}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${apiKey}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
        signal: AbortSignal.timeout(120000),
      });
    } catch (error) {
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
  return {
    models: () => request('/models?expand=category'),
    chat: (model, prompt) => request('/chat/completions', {
      method: 'POST', body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: false }),
    }),
  };
}

module.exports = { createApimartClient };
