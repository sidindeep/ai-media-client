(() => {
  const $ = id => document.getElementById(id);
  if (!$('generationProvider')) return;
  const account = document.querySelector('meta[name="account-id"]')?.content || 'local';
  const key = `media.codex-settings.${account}`;
  const names = { none: 'Без рассуждения', minimal: 'Минимальный', low: 'Низкий', medium: 'Средний', high: 'Высокий', xhigh: 'Очень высокий', max: 'Максимальный', ultra: 'Ультра' };
  let catalog, permissions, ready = false, priced = false, quoteRevision = 0, pending = null, timer, progressTimer, settings = {};
  try { settings = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch {}
  const save = () => { try { localStorage.setItem(key, JSON.stringify(settings)); } catch {} };
  const refreshSavedHistory = () => {
    if (typeof refreshHistory === 'function') void refreshHistory().then(() => {
      if (typeof renderSpending === 'function') renderSpending();
    }).catch(() => {});
  };
  document.getElementById('appTabs').addEventListener('click', event => {
    if (event.target.closest('[data-page="pageHistory"], [data-page="pageSpending"]')) refreshSavedHistory();
  });
  window.renderCodexHistory = (record, states) => {
    const card = document.createElement('article'); card.className = 'card compact-history';
    const title = document.createElement('strong'); title.textContent = `Codex CLI · ${record.modelName}`;
    const meta = document.createElement('p'); meta.className = 'hint';
    meta.textContent = [new Date(record.createdAt).toLocaleString('ru-RU'), states[record.state] || record.state,
      record.generationDurationMs != null ? `Время генерации: ${formatDuration(record.generationDurationMs)}` : '',
      recordCostText(record), record.usage ? `Токены: ${record.usage.total_tokens.toLocaleString('ru-RU')}` : '',
      names[record.input.effort] || record.input.effort, record.input.speed === 'fast' ? 'Fast' : 'Обычная скорость'].filter(Boolean).join(' · ');
    const detail = document.createElement('details');
    const heading = document.createElement('summary'); heading.textContent = record.input.prompt || 'Без промпта';
    const prompt = document.createElement('p'); prompt.textContent = record.input.prompt;
    detail.append(heading, prompt);
    if (record.output) { const output = document.createElement('pre'); output.className = 'codex-output'; output.textContent = record.output; detail.append(output); }
    if (record.error) { const error = document.createElement('p'); error.textContent = record.error; detail.append(error); }
    card.append(title, meta, detail);
    for (const file of record.localFiles || []) {
      const image = document.createElement('img'); image.src = file.previewUrl; image.alt = record.input.prompt || 'Результат Codex'; image.loading = 'lazy'; image.className = 'codex-history-image';
      const link = document.createElement('a'); link.href = file.url; link.download = file.name; link.textContent = 'Скачать PNG';
      card.append(image, link);
    }
    return card;
  };
  const model = () => catalog?.models.find(item => item.id === $('codexModel').value);
  const effort = () => model()?.efforts[Number($('codexEffort').value)];
  const route = value => `Codex CLI → ${value.model}${value.kind === 'image' ? ' → генератор изображений' : ' · Текст'} · ${names[value.effort] || value.effort} · ${value.speed === 'fast' ? '⚡ Fast' : 'Обычная скорость'}`;
  const routeNode = document.createElement('p'); routeNode.id = 'kieRoute'; routeNode.className = 'card'; routeNode.setAttribute('role', 'status');
  $('generate').before(routeNode);
  const updateKieRoute = () => { routeNode.textContent = `Запрос пойдёт через Kie.ai → ${$('title').textContent}`; };
  new MutationObserver(updateKieRoute).observe($('title'), { childList: true, characterData: true, subtree: true }); updateKieRoute();
  $('generationForm').addEventListener('submit', event => {
    if ($('generationProvider').value === 'codex') { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  function switchProvider() {
    const codex = $('generationProvider').value === 'codex';
    $('kieModelControls').hidden = codex; $('codexModelsMenu').hidden = !codex;
    $('kieGeneration').hidden = codex; $('codexGeneration').hidden = !codex;
    document.body.classList.toggle('codex-active', codex);
    settings.provider = $('generationProvider').value; save();
  }
  $('generationProvider').disabled = true;
  $('generationProvider').addEventListener('change', switchProvider);
  function describe() {
    if (!model()) return;
    settings.model = model().id; settings.effort = effort(); settings.speed = $('codexSpeed').value;
    settings.kind = $('codexKind').value;
    $('codexModelDetails').textContent = names[effort()] || effort();
    $('codexEffort').setAttribute('aria-valuetext', $('codexModelDetails').textContent);
    $('codexTitle').textContent = model().name;
    $('codexRoute').textContent = 'Запрос пойдёт через ' + route(settings);
    $('codexSpeedHint').textContent = settings.speed === 'fast' ? 'Приоритетная обработка. Цена указана перед запуском.' : 'Стандартная обработка запроса.';
    save();
    void updateQuote();
  }
  async function updateQuote() {
    const revision = ++quoteRevision; priced = false; busy(Boolean(pending));
    if (!model()) return;
    $('codexPrice').textContent = 'Проверка цены…';
    try {
      const value = await api('/api/codex/quote?' + new URLSearchParams({ model: model().id, effort: effort(), speed: $('codexSpeed').value }));
      if (revision !== quoteRevision) return;
      priced = Boolean(value.quote);
      $('codexPrice').textContent = value.quote ? `Цена: ${value.quote.credits.toLocaleString('ru-RU')} кредитов` : value.error;
    } catch { if (revision === quoteRevision) $('codexPrice').textContent = 'Цена недоступна. Запуск закрыт.'; }
    if (revision === quoteRevision) busy(Boolean(pending));
  }
  function selectModel(preferred) {
    const current = model(); if (!current) return;
    $('codexEffort').max = current.efforts.length - 1;
    $('codexEffort').value = Math.max(0, current.efforts.indexOf(current.efforts.includes(preferred) ? preferred : current.defaultEffort));
    describe();
  }
  $('codexModel').addEventListener('change', () => selectModel());
  $('codexEffort').addEventListener('input', describe);
  $('codexSpeed').addEventListener('change', describe);
  $('codexKind').addEventListener('change', describe);
  $('codexResetEffort').addEventListener('click', () => selectModel());
  $('codexPrompt').value = typeof settings.prompt === 'string' ? settings.prompt : '';
  $('codexPrompt').addEventListener('input', () => { settings.prompt = $('codexPrompt').value; save(); });
  function busy(value) {
    // Keep the prompt editable while a previous job is being reconciled. The
    // submit button remains locked by `value`, so editing cannot create a
    // second paid request with the same pending job.
    for (const id of ['codexModel', 'codexEffort', 'codexSpeed', 'codexKind', 'codexResetEffort']) $(id).disabled = value || !catalog;
    $('codexPrompt').disabled = !catalog;
    $('codexSubmit').disabled = value || !ready || !priced;
  }
  async function api(url, options = {}) {
    const isSubmit = options.method === 'POST' && url.endsWith('/api/codex/jobs');
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(isSubmit ? 60000 : 15000), headers: { 'Content-Type': 'application/json', 'X-Media-Client': 'web', 'X-Media-User': account } });
    const body = await response.json().catch(() => null);
    // Proxy errors are not job responses: even a plain-text 404 must keep the
    // pending ID, since it does not prove that the worker rejected the job.
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error(`Сервис вернул некорректный ответ (HTTP ${response.status}). Статус генерации неизвестен. Проверьте статус позже.`);
    }
    if (!response.ok) throw Object.assign(new Error(body.error || 'Не удалось выполнить запрос'), { status: response.status });
    return body;
  }
  function receipt(job) {
    const format = n => n.toLocaleString('ru-RU');
    let text = 'Ответ получен от Codex CLI.' + (job.nativeQuote ? ` Списано: ${format(job.nativeQuote.credits)} кредитов.` : '');
    if (job.durationMs != null) text += ` Время генерации: ${formatDuration(job.durationMs)}.`;
    if (!job.usage) return text + ' Расход токенов не предоставлен.';
    const u = job.usage;
    text += ` Токены: ${format(u.total_tokens)} (вход: ${format(u.input_tokens)}, выход: ${format(u.output_tokens)}`;
    if (u.cached_input_tokens !== null) text += `; из входных — кэш: ${format(u.cached_input_tokens)}`;
    if (u.reasoning_output_tokens !== null) text += `; из выходных — рассуждения: ${format(u.reasoning_output_tokens)}`;
    return text + ').';
  }
  function formatDuration(ms) {
    const seconds = Math.max(0, Math.round(Number(ms) / 1000));
    if (seconds < 60) return `${seconds} с`;
    return `${Math.floor(seconds / 60)} мин ${String(seconds % 60).padStart(2, '0')} с`;
  }
  function elapsed(job) {
    const started = Date.parse(job.startedAt || job.createdAt);
    return Number.isFinite(started) ? formatDuration(job.durationMs ?? (Date.now() - started)) : '—';
  }
  function stage(job) {
    if (job.state === 'submitting') return 'отправка в worker';
    if (job.state === 'running') return job.kind === 'image' ? 'генерация изображения' : 'получение ответа';
    return job.state;
  }
  function showProgress(job) {
    clearInterval(progressTimer);
    const render = () => { $('codexStatus').textContent = `Codex: ${stage(job)} · Прошло: ${elapsed(job)}`; };
    render();
    if (['running', 'submitting'].includes(job.state)) progressTimer = setInterval(render, 1000);
  }
  function result(job) {
    refreshSavedHistory();
    $('codexResultRoute').textContent = route(job);
    if (['running', 'submitting'].includes(job.state)) {
      showProgress(job);
      timer = setTimeout(check, 1500); return;
    }
    clearInterval(progressTimer);
    if (job.state === 'unknown') {
      $('codexStatus').textContent = job.error;
      $('codexCheck').hidden = false; busy(true); return;
    }
    pending = null; delete settings.pending;
    $('codexCheck').hidden = true; busy(false);
    if (job.state === 'success') {
      $('codexOutput').textContent = job.output; $('codexOutput').hidden = false;
      $('codexStatus').textContent = receipt(job);
      showImage(job);
      settings.result = { id: job.id, hasImage: job.hasImage, kind: job.kind, output: job.output, model: job.model, effort: job.effort, speed: job.speed, usage: job.usage, nativeQuote: job.nativeQuote, durationMs: job.durationMs, startedAt: job.startedAt, completedAt: job.completedAt };
    } else $('codexStatus').textContent = job.error || 'Ошибка Codex';
    save();
  }
  function showImage(job) {
    const available = job.hasImage === true && /^[a-f0-9-]{36}$/.test(job.id || '');
    $('codexImageResult').hidden = !available;
    if (available) {
      const url = '/api/codex/jobs/' + job.id + '/image';
      $('codexImage').src = url; $('codexDownload').href = url + '?download=1';
    } else { $('codexImage').removeAttribute('src'); $('codexDownload').removeAttribute('href'); }
  }
  async function check() {
    clearTimeout(timer); if (!pending) return;
    $('codexCheck').hidden = true;
    try { result(await api('/api/codex/jobs/' + pending)); if (typeof refreshBalance === 'function') void refreshBalance(); }
    catch (error) {
      if (error.status === 404) { pending = null; delete settings.pending; save(); busy(false); }
      else {
        // A status GET is safe to repeat. Keep the request ID and recover from
        // a transient DB/proxy disconnect without submitting a paid job again.
        $('codexStatus').textContent = 'Связь с сервисом прервана. Проверяю статус генерации…';
        $('codexCheck').hidden = true;
        timer = setTimeout(check, 3000);
      }
    }
  }
  $('codexCheck').addEventListener('click', check);
  $('codexForm').addEventListener('submit', async event => {
    event.preventDefault(); if (!ready || !priced || pending || $('generationProvider').value !== 'codex') return;
    const request = { prompt: $('codexPrompt').value, model: model().id, effort: effort(), speed: $('codexSpeed').value, kind: $('codexKind').value, requestId: crypto.randomUUID() };
    pending = request.requestId; settings.pending = pending; save(); busy(true);
    showProgress({ state: 'submitting', kind: request.kind, startedAt: new Date().toISOString() }); $('codexOutput').hidden = true;
    showImage({});
    try { result(await api('/api/codex/jobs', { method: 'POST', body: JSON.stringify(request) })); }
    catch (error) {
      if ([400, 403, 409, 429].includes(error.status)) {
        $('codexStatus').textContent = error.message;
        pending = null; delete settings.pending; save(); busy(false);
      } else {
        $('codexStatus').textContent = 'Отправка прервана. Проверяю, успел ли сервис принять запрос…';
        timer = setTimeout(check, 3000);
      }
    }
  });
  async function load() {
    try {
      [catalog, permissions] = await Promise.all([api('/codex-models.json'), api('/api/codex/status')]);
      settings = { ...catalog.uiDefaults, ...settings };
      $('generationProvider').value = settings.provider === 'codex' ? 'codex' : 'kie';
      switchProvider();
      $('generationProvider').disabled = false;
      $('codexModel').replaceChildren(...catalog.models.map(item => new Option(item.name, item.id)));
      $('codexModel').value = catalog.models.some(item => item.id === settings.model) ? settings.model : (catalog.models.find(item => item.isDefault) || catalog.models[0]).id;
      $('codexSpeed').value = settings.speed === 'fast' ? 'fast' : 'standard';
      $('codexKind').value = settings.kind === 'text' ? 'text' : 'image';
      selectModel(settings.effort);
      $('codexModelsDate').textContent = `Каталог проверен ${new Date(catalog.checkedAt).toLocaleDateString('ru-RU')}.`;
      ready = permissions.enabled && permissions.allowed;
      if (!ready) $('codexStatus').textContent = 'Для Codex нужны подключённый сервис и кредитный счёт.';
      if (settings.result) { $('codexOutput').textContent = settings.result.output; $('codexOutput').hidden = false; $('codexResultRoute').textContent = route(settings.result); $('codexStatus').textContent = receipt(settings.result); showImage(settings.result); }
      pending = typeof settings.pending === 'string' ? settings.pending : null;
      busy(Boolean(pending)); if (pending && ready) void check();
    } catch { $('generationProvider').disabled = false; $('codexStatus').textContent = 'Не удалось подключить Codex. Обновите страницу позже.'; }
  }
  void load();
})();
