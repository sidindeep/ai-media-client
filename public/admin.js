let grantReference = crypto.randomUUID();
let accountRows = [];
let creditScale = 1000;
let roleTargetId;
let ledgerSequence = 0;
const formatCredits = value => new Intl.NumberFormat(document.documentElement.lang, { maximumFractionDigits: 3 }).format(value);
function showBalance() {
  const row = accountRows.find(item => item.id === document.getElementById('grantAccount').value);
  document.getElementById('grantBalance').textContent = row
    ? `Доступно: ${formatCredits((Number(row.balance) - Number(row.held)) / creditScale)} кредитов · в резерве: ${formatCredits(Number(row.held) / creditScale)}` : '';
  void loadLedger();
}
function selectPanel() {
  const panels = ['accountsPanel', 'starterPanel', 'credits', 'conversionPanel', 'billingRisksPanel', 'auditPanel', 'reconcilePanel', 'kieSubmissionsPanel', 'kieSessionPanel', 'codexPanel'];
  const selected = panels.includes(location.hash.slice(1)) ? location.hash.slice(1) : panels[0];
  for (const id of panels) document.getElementById(id).hidden = id !== selected;
  document.querySelectorAll('.admin-tabs a').forEach(link => link.setAttribute('aria-current', link.hash === '#' + selected ? 'page' : 'false'));
}
window.addEventListener('hashchange', selectPanel);
selectPanel();
const kieStatsDate = value => new Date(value).toLocaleString(document.documentElement.lang);
function kieStatsNode(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
const conversionNumber = value => new Intl.NumberFormat(document.documentElement.lang, { maximumFractionDigits: 4 }).format(value);
function renderConversion(data) {
  const summary = [
    ['Версия политики', data.version],
    ['Удержания', `${conversionNumber(data.deductionsFraction * 100)}%`],
    ['Наценка к себестоимости', `${conversionNumber(data.costMarkupFraction * 100)}%`],
    ['Минимальная цена покупки кредита', `${conversionNumber(data.minimumRubPerCredit)} ₽`],
    ['Выручка после удержаний за кредит', `${conversionNumber(data.netRubPerCredit)} ₽`],
    ['Себестоимость кредита Kie', `${conversionNumber(data.kieRubPerCredit)} ₽`],
  ];
  document.getElementById('conversionSummary').replaceChildren(...summary.map(([label, value]) => {
    const card = kieStatsNode('div', undefined, 'kie-stats-card');
    card.append(kieStatsNode('span', label), kieStatsNode('strong', String(value)));
    return card;
  }));
  document.getElementById('conversionProviders').replaceChildren(...data.providers.map(row => {
    const card = kieStatsNode('article', undefined, 'kie-stats-incident');
    const mode = row.mode === 'fixed-product-price' ? 'Фиксированная продуктовая цена' : 'Расчёт по себестоимости';
    const example = row.exampleCredits == null ? 'Цена берётся из опубликованного тарифа модели'
      : `${conversionNumber(row.exampleInput)} ${row.sourceUnit} → ${conversionNumber(row.exampleCredits)} наших кредитов`;
    card.append(kieStatsNode('strong', `${row.id} · ${mode}`), kieStatsNode('p', example));
    return card;
  }));
  document.getElementById('conversionOffers').replaceChildren(...data.offers.map(row =>
    kieStatsNode('p', `${row.name} · ${conversionNumber(row.priceRub)} ₽ за ${conversionNumber(row.credits)} кредитов · ${conversionNumber(row.rubPerCredit)} ₽ за кредит`)));
  document.getElementById('conversionFx').replaceChildren(...(data.fxRates.length ? data.fxRates.map(row =>
    kieStatsNode('p', `${row.currency}: ${conversionNumber(row.rubPerUnit)} ₽ · версия ${row.version} · действует до ${kieStatsDate(row.validUntil)}`))
    : [kieStatsNode('p', 'Иностранные валюты пока не подключены.') ]));
}
let conversionBusy = false;
async function loadConversion() {
  if (conversionBusy) return;
  conversionBusy = true;
  const status = document.getElementById('conversionStatus');
  status.textContent = 'Загружаем данные…';
  try { renderConversion(await adminRequest('/api/admin/credit-conversion')); status.textContent = `Обновлено ${kieStatsDate(new Date())}`; }
  catch (error) { status.textContent = error.message; }
  finally { conversionBusy = false; }
}
document.getElementById('conversionRefresh').onclick = () => void loadConversion();
window.addEventListener('hashchange', () => { if (location.hash === '#conversionPanel') void loadConversion(); });
if (location.hash === '#conversionPanel') queueMicrotask(() => void loadConversion());
function renderKieStats(stats) {
  const summary = document.getElementById('kieStatsSummary');
  summary.replaceChildren(...[
    ['Отправлено генераций', stats.submitted],
    ['Неопределённых ответов', stats.unknown],
    ['Доля', `${new Intl.NumberFormat(document.documentElement.lang, { maximumFractionDigits: 2 }).format(stats.ratePercent)}%`],
    ['Попыток POST', stats.attempts],
  ].map(([label, value]) => { const card = kieStatsNode('div', undefined, 'kie-stats-card'); card.append(kieStatsNode('span', label), kieStatsNode('strong', String(value))); return card; }));
  const days = stats.daily;
  const countChart = document.getElementById('kieStatsCountChart');
  const maximum = Math.max(1, ...days.map(row => row.submitted));
  countChart.setAttribute('aria-label', `По дням: ${days.map(row => `${row.date}: ${row.submitted} генераций, ${row.unknown} неопределённых`).join('; ') || 'Нет данных'}`);
  countChart.replaceChildren(...days.map(row => {
    const column = kieStatsNode('div', undefined, 'kie-stats-column');
    column.title = `${row.date}: ${row.submitted} генераций, ${row.unknown} неопределённых`;
    const bars = kieStatsNode('div', undefined, 'kie-stats-bars');
    for (const [kind, value] of [['submitted', row.submitted], ['unknown', row.unknown]]) {
      const bar = kieStatsNode('span', undefined, `kie-stats-bar kie-stats-${kind}`);
      bar.style.height = `${Math.max(value ? 3 : 0, value / maximum * 100)}%`;
      bars.append(bar);
    }
    column.append(bars, kieStatsNode('small', row.date.slice(5)));
    return column;
  }));
  const rateChart = document.getElementById('kieStatsRateChart');
  rateChart.setAttribute('aria-label', `Доля по дням: ${days.map(row => `${row.date}: ${row.submitted ? (row.unknown / row.submitted * 100).toFixed(1) : 0}%`).join('; ') || 'Нет данных'}`);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 600 130'); svg.setAttribute('preserveAspectRatio', 'none');
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  line.setAttribute('points', days.map((row, index) => `${days.length === 1 ? 300 : index * 600 / (days.length - 1)},${120 - (row.unknown / row.submitted) * 110}`).join(' '));
  line.setAttribute('fill', 'none'); line.setAttribute('stroke', '#ee879f'); line.setAttribute('stroke-width', '3');
  svg.append(line); rateChart.replaceChildren(svg);
  const daily = document.getElementById('kieStatsDaily');
  daily.replaceChildren(...days.map(row => kieStatsNode('p', `${row.date} · ${row.submitted} генераций · ${row.unknown} неопределённых · ${(row.unknown / row.submitted * 100).toFixed(2)}%`)));
  const incidents = document.getElementById('kieStatsIncidents');
  incidents.replaceChildren(...(stats.incidents.length ? stats.incidents.map(row => {
    const card = kieStatsNode('article', undefined, 'kie-stats-incident');
    card.append(kieStatsNode('strong', `${kieStatsDate(row.startedAt)} · ${row.accountName} · ${row.kieAccountId}`),
      kieStatsNode('p', `Задача: ${row.jobId} · requestId: ${row.requestId || '—'} · чат: ${row.chatId || '—'} · модель: ${row.modelId || '—'}`),
      kieStatsNode('p', `Причина: ${row.errorCode || 'нет кода'} · ${row.errorMessage || 'ответ createTask не установлен'}`));
    const button = kieStatsNode('button', 'Открыть сверку'); button.type = 'button';
    button.onclick = () => { document.getElementById('reconcileAccount').value = row.accountId; document.getElementById('reconcileJob').value = row.jobId; location.hash = 'reconcilePanel'; };
    card.append(button); return card;
  }) : [kieStatsNode('p', 'За выбранный период случаев нет.') ]));
}
let kieStatsBusy = false;
async function loadKieStats() {
  if (kieStatsBusy) return;
  kieStatsBusy = true;
  const status = document.getElementById('kieStatsStatus');
  status.textContent = 'Загружаем данные…';
  try { const stats = await adminRequest('/api/admin/kie-submissions?days=' + document.getElementById('kieStatsDays').value); renderKieStats(stats); status.textContent = `Обновлено ${kieStatsDate(new Date())}`; }
  catch (error) { status.textContent = error.message; }
  finally { kieStatsBusy = false; }
}
document.getElementById('kieStatsDays').onchange = () => void loadKieStats();
document.getElementById('kieStatsRefresh').onclick = () => void loadKieStats();
window.addEventListener('hashchange', () => { if (location.hash === '#kieSubmissionsPanel') void loadKieStats(); });
if (location.hash === '#kieSubmissionsPanel') queueMicrotask(() => void loadKieStats());
let billingRisksData = null;
function renderBillingRisks(data) {
  const summary = data.summary;
  document.getElementById('billingRisksSummary').replaceChildren(...[
    ['Расход при возврате', summary.confirmedMismatch],
    ['Возврат после отправки', summary.releasedAfterSend],
    ['Резерв до сверки', summary.heldUnknown],
    ['Возвращено в спорных задачах', `${formatCredits(summary.reviewReleasedUnits / creditScale)} кредита`],
  ].map(([label, value]) => {
    const card = kieStatsNode('div', undefined, 'kie-stats-card');
    card.append(kieStatsNode('span', label), kieStatsNode('strong', String(value)));
    return card;
  }));
  const provider = document.getElementById('billingRisksProvider').value;
  const search = document.getElementById('billingRisksSearch').value.trim().toLowerCase();
  const rows = data.incidents.filter(row => (provider === 'all' || row.provider === provider)
    && (!search || [row.accountName, row.accountId, row.jobId, row.providerTaskId].join(' ').toLowerCase().includes(search)));
  document.getElementById('billingRisksIncidents').replaceChildren(...(rows.length ? rows.map(row => {
    const labels = { confirmed_mismatch: 'КРИТИЧНО · известен расход при возврате', released_after_send: 'Проверить расход после отправки', held_unknown: 'Неизвестный результат · резерв удержан' };
    const card = kieStatsNode('article', undefined, `kie-stats-incident billing-risk-${row.risk}`);
    card.append(kieStatsNode('strong', `${labels[row.risk]} · ${row.provider.toUpperCase()} · ${kieStatsDate(row.createdAt)}`),
      kieStatsNode('p', `${row.accountName} · ${row.accountId} · ${row.model || 'модель не указана'}`),
      kieStatsNode('p', `Наша задача: ${row.jobId} · задача поставщика: ${row.providerTaskId || 'нет ID'} · статус: ${row.state || 'неизвестен'}`),
      kieStatsNode('p', `Резерв ${formatCredits(row.reservedUnits / creditScale)} · списано ${formatCredits(row.capturedUnits / creditScale)} · возвращено ${formatCredits(row.releasedUnits / creditScale)} · удержано ${formatCredits(row.heldUnits / creditScale)} наших кредитов`),
      kieStatsNode('p', row.providerCost == null ? 'Фактический расход поставщика не получен' : `Известный расход поставщика: ${row.providerCost} ${row.providerCostUnit}`));
    if (row.providerUsageTokens) card.append(kieStatsNode('p', `Использование Codex: ${row.providerUsageTokens} токенов`));
    if (row.risk === 'held_unknown') {
      const button = kieStatsNode('button', 'Открыть ручную сверку'); button.type = 'button';
      button.onclick = () => { document.getElementById('reconcileAccount').value = row.accountId; document.getElementById('reconcileJob').value = row.jobId; location.hash = 'reconcilePanel'; };
      card.append(button);
    }
    return card;
  }) : [kieStatsNode('p', 'По выбранному фильтру задач нет.') ]));
  if (data.totalIncidents > data.incidents.length) document.getElementById('billingRisksIncidents').append(kieStatsNode('p', `Показаны первые ${data.incidents.length} из ${data.totalIncidents} задач.`));
}
async function loadBillingRisks() {
  const status = document.getElementById('billingRisksStatus');
  status.textContent = 'Загружаем данные…';
  try {
    billingRisksData = await adminRequest('/api/admin/billing-reconciliation?days=' + document.getElementById('billingRisksDays').value);
    renderBillingRisks(billingRisksData);
    status.textContent = `Обновлено ${kieStatsDate(new Date())}`;
  } catch (error) { status.textContent = error.message; }
}
document.getElementById('billingRisksDays').onchange = () => void loadBillingRisks();
document.getElementById('billingRisksProvider').onchange = () => { if (billingRisksData) renderBillingRisks(billingRisksData); };
document.getElementById('billingRisksSearch').oninput = () => { if (billingRisksData) renderBillingRisks(billingRisksData); };
document.getElementById('billingRisksRefresh').onclick = () => void loadBillingRisks();
window.addEventListener('hashchange', () => { if (location.hash === '#billingRisksPanel') void loadBillingRisks(); });
if (location.hash === '#billingRisksPanel') queueMicrotask(() => void loadBillingRisks());
function renderAccounts() {
  const search = document.getElementById('accountSearch').value.trim().toLowerCase();
  const rows = accountRows.filter(row => [row.name, row.email, row.id].join(' ').toLowerCase().includes(search));
  document.getElementById('accounts').replaceChildren(...rows.map(row => {
    const card = document.createElement('article'); card.className = 'admin-account-row';
    const info = document.createElement('div'), link = document.createElement('a'), detail = document.createElement('p');
    link.href = `/?account=${row.id}`; link.textContent = row.name;
    const starter = row.starterPack?.active ? 'стартер-пак: только GPT' : row.starterPack?.unlockedByPayment ? 'весь каталог открыт оплатой' : 'без стартер-ограничения';
    detail.textContent = `${row.email || row.id} · ${row.role === 'admin' ? 'Администратор' : 'Пользователь'} · ${starter} · доступно ${formatCredits((Number(row.balance) - Number(row.held)) / creditScale)} кредитов`;
    info.append(link, detail);
    const actions = document.createElement('div'); actions.className = 'account-controls';
    const grant = document.createElement('button'); grant.textContent = 'Пополнить'; grant.type = 'button';
    grant.onclick = () => { document.getElementById('grantAccount').value = row.id; showBalance(); location.hash = 'credits'; };
    const role = document.createElement('button'); role.textContent = 'Изменить роль'; role.type = 'button'; role.dataset.accountId = row.id;
    role.onclick = () => { roleTargetId = row.id; document.getElementById('roleTarget').textContent = `${row.name} · ${row.email || row.id}`; document.getElementById('roleValue').value = row.role; document.getElementById('roleReason').value = ''; document.getElementById('roleStatus').textContent = ''; document.getElementById('roleDialog').showModal(); };
    actions.append(grant, role); card.append(info, actions); return card;
  }));
}
document.getElementById('accountSearch').oninput = renderAccounts;
const currentAccount = fetch('/api/account').then(response => response.json()).then(body => body.result);
async function adminRequest(url, options) {
  const account = await currentAccount;
  const response = await fetch(url, { ...options, headers: { 'X-Media-Client': 'web', 'X-Media-User': account.id, 'Content-Type': 'application/json' } });
  const body = await response.json(); if (!response.ok) throw new Error(body.error); return body.result;
}
async function loadAccounts() {
  const account = await currentAccount, scale = account.wallet.scale;
  creditScale = scale;
  const rows = await adminRequest('/api/admin/accounts');
  accountRows = rows;
  renderAccounts();
  const select = document.getElementById('grantAccount'), selected = select.value;
  select.replaceChildren(...rows.map(row => new Option(`${row.name}${row.id === account.id ? ' — мой счёт' : ''} (${row.id})`, row.id))); select.value = selected || account.id;
  showBalance();
  const starter = await adminRequest('/api/admin/starter-pack');
  document.getElementById('starterOverview').replaceChildren(...[
    `Статус: ${starter.enabled ? 'включён' : 'выключен'} · версия ${starter.version}`,
    `Пакет: ${formatCredits(starter.credits)} кредитов · доступ: ${starter.modelAccess}`,
    `Активно: ${starter.active} · выдано: ${starter.enrolled} · разблокировано оплатой: ${starter.paid}`,
    `Условие разблокировки: платёжная проводка ${starter.unlockEvent}`,
  ].map(text => { const p = document.createElement('p'); p.textContent = text; return p; }));
  document.getElementById('reconcileAccount').replaceChildren(...rows.map(row => new Option(`${row.name} (${row.id})`, row.id)));
  const audit = await adminRequest('/api/admin/roles');
  document.getElementById('roleAudit').replaceChildren(...audit.map(row => { const p = document.createElement('p'); p.textContent = `${new Date(row.created_at).toLocaleString(document.documentElement.lang)} · ${row.name}: ${row.old_role} → ${row.new_role} · ${row.reason} · администратор: ${row.actor_id || 'назначение владельца'}`; return p; }));
}
async function loadLedger() {
  const sequence = ++ledgerSequence;
  const accountId = document.getElementById('grantAccount').value;
  if (!accountId) return;
  try {
    const rows = await adminRequest('/api/admin/ledger?account=' + encodeURIComponent(accountId));
    if (sequence !== ledgerSequence) return;
    const names = { grant: 'Начисление', purchase: 'Покупка', reserve: 'Резерв', capture: 'Списание', release: 'Возврат' };
    document.getElementById('creditLedger').replaceChildren(...rows.map(row => { const p = document.createElement('p'); p.textContent = `${new Date(row.created_at).toLocaleString(document.documentElement.lang)} · ${names[row.kind] || row.kind} · ${formatCredits(Number(row.amount) / creditScale)} · ${row.note}`; return p; }));
  } catch (error) { if (sequence === ledgerSequence) document.getElementById('creditLedger').textContent = error.message; }
}
document.getElementById('closeRoleDialog').onclick = () => document.getElementById('roleDialog').close();
document.getElementById('roleForm').onsubmit = async event => {
  event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
  try {
    await adminRequest('/api/admin/roles', { method: 'POST', body: JSON.stringify({ accountId: roleTargetId, role: document.getElementById('roleValue').value, reason: document.getElementById('roleReason').value }) });
    if (roleTargetId === (await currentAccount).id) { location.assign('/login'); return; }
    document.getElementById('roleDialog').close(); document.getElementById('adminStatus').textContent = 'Роль сохранена'; await loadAccounts();
  } catch (error) { document.getElementById('roleStatus').textContent = error.message; } finally { button.disabled = false; }
};
document.getElementById('reconcileForm').onsubmit = async event => {
  event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
  try { await adminRequest('/api/admin/reconcile', { method: 'POST', body: JSON.stringify({ accountId: document.getElementById('reconcileAccount').value, jobId: document.getElementById('reconcileJob').value, outcome: document.getElementById('reconcileOutcome').value, evidence: document.getElementById('reconcileEvidence').value }) }); document.getElementById('adminStatus').textContent = 'Результат сверки сохранён'; await loadAccounts(); }
  catch (error) { document.getElementById('adminStatus').textContent = error.message; } finally { button.disabled = false; }
};
document.getElementById('grantAccount').onchange = showBalance;
document.getElementById('grantSelf').onclick = async () => {
  document.getElementById('grantAccount').value = (await currentAccount).id;
  showBalance(); document.getElementById('grantAmount').focus();
};
document.getElementById('grantForm').onsubmit = async event => {
  event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
  document.getElementById('grantSelf').disabled = true;
  try {
    const scale = (await currentAccount).wallet.scale;
    const credits = Number(document.getElementById('grantAmount').value), amountUnits = Math.round(credits * scale);
    if (Math.abs(amountUnits / scale - credits) > 1e-9) throw new Error('Некорректная точность суммы');
    await adminRequest('/api/admin/grant', { method: 'POST', body: JSON.stringify({ accountId: document.getElementById('grantAccount').value, amountUnits, reference: grantReference, note: document.getElementById('grantNote').value }) });
    grantReference = crypto.randomUUID(); document.getElementById('adminStatus').textContent = 'Начисление сохранено'; await loadAccounts();
  } catch (error) { document.getElementById('adminStatus').textContent = error.message; }
  finally { button.disabled = false; document.getElementById('grantSelf').disabled = false; }
};
void loadAccounts().catch(error => { document.getElementById('adminStatus').textContent = error.message; });

(() => {
  const status = document.getElementById('kieSessionStatus');
  const open = document.getElementById('kieSessionOpen');
  const show = document.getElementById('kieSessionShow');
  const refresh = document.getElementById('kieSessionRefresh');
  const viewer = document.getElementById('kieBrowserViewer');
  const browserStatus = document.getElementById('kieBrowserStatus');
  const frame = document.getElementById('kieBrowserFrame');
  const textInput = document.getElementById('kieBrowserText');
  let timer, frameTimer, busy = false, frameBusy = false, inputQueue = Promise.resolve();
  const visible = () => location.hash === '#kieSessionPanel' && !viewer.hidden;
  async function updateFrame() {
    if (!visible() || frameBusy) return;
    frameBusy = true; clearTimeout(frameTimer);
    try {
      const value = await adminRequest('/api/admin/kie-session/frame');
      frame.src = 'data:image/jpeg;base64,' + value.image;
      browserStatus.textContent = '';
    } catch (error) { browserStatus.textContent = error.message || 'Экран браузера недоступен'; }
    finally { frameBusy = false; if (visible()) frameTimer = setTimeout(() => void updateFrame(), 1200); }
  }
  function send(action) {
    inputQueue = inputQueue.then(() => adminRequest('/api/admin/kie-session/input', { method: 'POST', body: JSON.stringify(action) }))
      .then(() => { if (visible()) void updateFrame(); })
      .catch(error => { browserStatus.textContent = error.message; });
  }
  async function update() {
    if (busy) return;
    busy = true; clearTimeout(timer); refresh.disabled = true;
    try {
      const value = await adminRequest('/api/admin/kie-session/status');
      status.textContent = ({ connected: 'Вход в кабинет Kie выполнен.', disconnected: 'Вход в Kie ещё не выполнен.', unavailable: 'Браузер Kie на сервере недоступен.' })[value.state] || 'Неизвестный статус.';
      show.hidden = !value.embedded;
      if (value.loginUrl && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(value.loginUrl)) {
        open.href = value.loginUrl; open.hidden = false;
      } else { open.removeAttribute('href'); open.hidden = true; }
    } catch (error) { status.textContent = error.message; open.hidden = true; }
    finally {
      busy = false; refresh.disabled = false;
      if (location.hash === '#kieSessionPanel') timer = setTimeout(() => void update(), 3000);
    }
  }
  show.onclick = () => { viewer.hidden = !viewer.hidden; show.textContent = viewer.hidden ? 'Открыть серверный браузер' : 'Скрыть серверный браузер'; if (visible()) void updateFrame(); else clearTimeout(frameTimer); };
  frame.onclick = event => {
    const rect = frame.getBoundingClientRect();
    send({ type: 'click', x: Math.round((event.clientX - rect.left) * frame.naturalWidth / rect.width), y: Math.round((event.clientY - rect.top) * frame.naturalHeight / rect.height) });
    frame.focus();
  };
  frame.onkeydown = event => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (['Enter', 'Tab', 'Backspace', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) send({ type: 'key', key: event.key });
    else if ([...event.key].length === 1) send({ type: 'text', text: event.key });
    else return;
    event.preventDefault();
  };
  frame.onpaste = event => { const value = event.clipboardData?.getData('text'); if (value) send({ type: 'text', text: value.slice(0, 2048) }); event.preventDefault(); };
  frame.onwheel = event => { send({ type: 'scroll', deltaY: Math.max(-1200, Math.min(1200, Math.round(event.deltaY))) }); event.preventDefault(); };
  document.getElementById('kieBrowserSendText').onclick = () => { if (textInput.value) send({ type: 'text', text: textInput.value }); textInput.value = ''; frame.focus(); };
  textInput.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); document.getElementById('kieBrowserSendText').click(); } };
  document.getElementById('kieBrowserBackspace').onclick = () => send({ type: 'key', key: 'Backspace' });
  document.getElementById('kieBrowserTab').onclick = () => send({ type: 'key', key: 'Tab' });
  document.getElementById('kieBrowserEnter').onclick = () => send({ type: 'key', key: 'Enter' });
  document.getElementById('kieBrowserReload').onclick = () => send({ type: 'reload' });
  refresh.onclick = () => void update();
  window.addEventListener('hashchange', () => { clearTimeout(timer); clearTimeout(frameTimer); if (location.hash === '#kieSessionPanel') { void update(); if (visible()) void updateFrame(); } });
  window.addEventListener('pagehide', () => { clearTimeout(timer); clearTimeout(frameTimer); });
  if (location.hash === '#kieSessionPanel') void update();
})();

// Poll only while this panel is visible; returning to it recovers an active login.
(() => {
  const status = document.getElementById('codexLoginStatus');
  const start = document.getElementById('codexLoginStart');
  const refresh = document.getElementById('codexLoginRefresh');
  const cancel = document.getElementById('codexLoginCancel');
  let timer, busy = false;
  async function update(action = 'status') {
    if (busy) return;
    busy = true; clearTimeout(timer); start.disabled = refresh.disabled = cancel.disabled = true;
    try {
      const value = await adminRequest('/api/admin/codex/' + action, { method: action === 'status' ? 'GET' : 'POST' });
      const running = value.state === 'running';
      status.textContent = ({ connected: 'Codex подключён. Можно запускать генерации.', disconnected: 'Codex ещё не подключён.', idle: 'Вход отменён. Можно проверить текущий статус или начать заново.', running: value.code ? 'Ожидаем подтверждения входа в браузере.' : 'Получаем одноразовый код…', failed: 'Вход не завершён: код истёк или CLI не смог войти. Попробуйте снова.' })[value.state] || 'Неизвестный статус.';
      document.getElementById('codexLoginInstructions').hidden = !running || !value.code;
      document.getElementById('codexLoginCode').textContent = running ? value.code || '' : '';
      cancel.hidden = !running; start.disabled = running;
      start.textContent = value.state === 'connected' ? 'Войти другим аккаунтом' : 'Войти в Codex';
      if (running && location.hash === '#codexPanel') timer = setTimeout(() => void update(), 2000);
    } catch (error) {
      status.textContent = error.message;
      document.getElementById('codexLoginInstructions').hidden = true;
      document.getElementById('codexLoginCode').textContent = '';
      start.disabled = false;
    } finally { busy = false; refresh.disabled = cancel.disabled = false; }
  }
  start.onclick = () => void update('start');
  refresh.onclick = () => void update();
  cancel.onclick = () => void update('cancel');
  const show = () => { clearTimeout(timer); if (location.hash === '#codexPanel') void update(); };
  window.addEventListener('hashchange', show);
  window.addEventListener('pagehide', () => clearTimeout(timer));
  show();
})();
