const { providerError } = require('../../services/codex-errors');
const { validatePng, MAX_IMAGE_BYTES } = require('../../services/codex-images');
const { parseRetryAfter } = require('../../retry-after');

// The only application client of the private worker HTTP contract.
// Owns transport errors, timeouts and acceptance evidence, never wallet state.
function createCodexWorkerClient({ url, fetchImpl = fetch }) {
  const base = url.replace(/\/$/, '');
  async function json(account, pathname, { body, method = body ? 'POST' : 'GET', timeout = 10000 } = {}) {
    const response = await fetchImpl(base + pathname, { method,
      headers: { 'Content-Type': 'application/json', 'X-Account-Id': account },
      body: body && JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
    let value;
    try { value = typeof response.text === 'function' ? JSON.parse(await response.text()) : await response.json(); }
    catch { throw Object.assign(new Error(`Codex вернул некорректный ответ (HTTP ${response.status})`), { remoteStatus: response.status }); }
    if (!response.ok) throw Object.assign(providerError(value.error || value, `Codex HTTP ${response.status}`), {
      code: `CODEX_HTTP_${response.status}`, remoteStatus: response.status,
      confirmedRejected: response.status === 429 && value?.accepted === false,
      retryAfterMs: parseRetryAfter(response.headers?.get?.('retry-after')),
    });
    return value;
  }
  return Object.freeze({
    listModels: () => json('local', '/models'),
    submit: (account, body) => json(account, '/jobs', { body }),
    getTask: (account, requestId) => json(account, '/jobs/' + requestId),
    acknowledgeImage: (account, requestId) => json(account, '/jobs/' + requestId + '/ack', { body: {} }),
    async getImage(account, requestId) {
      const response = await fetchImpl(base + '/jobs/' + requestId + '/image', {
        headers: { 'X-Account-Id': account }, signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw Object.assign(new Error('Изображение Codex недоступно'), { remoteStatus: response.status });
      const length = Number(response.headers?.get?.('content-length'));
      if (Number.isFinite(length) && length > MAX_IMAGE_BYTES) throw new Error('Изображение Codex слишком большое');
      return validatePng(Buffer.from(await response.arrayBuffer()));
    },
    auth(account, action) {
      if (!['status', 'start', 'cancel', 'limits'].includes(action)) throw new TypeError('Invalid Codex auth action');
      return json(account, '/auth/' + action, { method: ['start', 'cancel'].includes(action) ? 'POST' : 'GET', timeout: 15000 });
    },
  });
}

module.exports = { createCodexWorkerClient };
