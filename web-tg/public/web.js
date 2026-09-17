(() => {
  const methods = ['getCatalog', 'getHistory', 'keyStatus', 'getBalance', 'queueStatus', 'startQueue', 'pauseQueue', 'setConcurrency', 'cancelQueued', 'removeQueued', 'clearQueue', 'acknowledgeTask', 'createTask', 'getTask', 'getFavoriteModels', 'setFavoriteModels', 'listTemplates', 'saveTemplate', 'removeTemplate', 'loadDrafts', 'saveDrafts', 'costSettings', 'setCreditRate', 'getTariffs', 'getTariffDescriptions', 'storageSettings', 'setAutoSave'];
  async function request(url, options) {
    let response;
    try { response = await fetch(url, { ...options, headers: { 'X-Media-Client': 'web', ...options?.headers } }); }
    catch { throw new Error('Нет связи с сервисом. Запрос не повторяется автоматически. Проверьте историю перед повторным запуском.'); }
    const body = await response.json().catch(() => null);
    if (!response.ok || !body) throw new Error(body?.error || 'Некорректный ответ сервиса');
    return body.result;
  }
  const rpc = (name, args) => request(`/api/rpc/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
  const api = { isWeb: true };
  for (const method of methods) api[method] = (...args) => rpc(method, args);
  const draftKey = 'ai-media.pending-draft.v1';
  api.saveDrafts = async data => {
    const serialized = JSON.stringify(data);
    try { localStorage.setItem(draftKey, serialized); } catch { /* Server persistence still works. */ }
    const result = await rpc('saveDrafts', [data]);
    try { if (localStorage.getItem(draftKey) === serialized) localStorage.removeItem(draftKey); } catch {}
    return result;
  };
  api.loadDrafts = async () => {
    try { const pending = localStorage.getItem(draftKey); if (pending) return JSON.parse(pending); } catch {}
    return rpc('loadDrafts', []);
  };
  api.saveSource = file => request(`/api/source?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file.bytes });
  api.sourcePreview = async ref => {
    const match = /^https:\/\/local-assets\.invalid\/([a-f0-9]{64})$/.exec(ref);
    if (!match) throw new Error('Некорректный исходник'); return `/api/sources/${match[1]}`;
  };
  api.getKieSessionQuote = async () => null;
  api.getPriceAudit = async () => null;
  api.autoPriceAudit = async () => false;
  api.finishClose = () => {};
  api.saveResults = async id => {
    const files = await rpc('saveResults', [id]);
    for (const file of files) { const link = document.createElement('a'); link.href = file.url; link.download = ''; document.body.append(link); link.click(); link.remove(); }
    return files;
  };
  api.revealResult = async (id, index) => {
    const link = document.createElement('a'); link.href = `/api/results/${encodeURIComponent(id)}/${index}?download=1`; link.download = ''; link.click();
  };
  const events = new EventSource('/api/events');
  api.onQueueChanged = callback => { events.addEventListener('message', callback); return () => events.removeEventListener('message', callback); };
  window.desktop = api; // Compatibility port for the shared desktop/browser presentation.
  document.addEventListener('DOMContentLoaded', () => {
    const state = document.getElementById('serviceState');
    const update = async () => {
      try {
        const health = await fetch('/api/health').then(response => response.json());
        state.textContent = health.generationConfigured ? 'Генерация подключена' : 'Генерация пока не подключена';
        const bot = document.getElementById('botState');
        bot.textContent = health.telegram.enabled ? 'Telegram-бот включён' : 'Telegram-бот ожидает подключения';
      } catch { state.textContent = 'Нет связи с сервисом'; }
    };
    void update(); events.onopen = update;
    events.onerror = () => { state.textContent = 'Переподключение к сервису…'; };
    document.getElementById('pauseQueue').onclick = () => api.pauseQueue().catch(error => { state.textContent = error.message; });
  });
})();
