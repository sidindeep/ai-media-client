let grantReference = crypto.randomUUID();
let accountRows = [];
let creditScale = 1000;
let roleTargetId;
let ledgerSequence = 0;
const formatCredits = value => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 }).format(value);
function showBalance() {
  const row = accountRows.find(item => item.id === document.getElementById('grantAccount').value);
  document.getElementById('grantBalance').textContent = row
    ? `Доступно: ${formatCredits((Number(row.balance) - Number(row.held)) / creditScale)} кредитов · в резерве: ${formatCredits(Number(row.held) / creditScale)}` : '';
  void loadLedger();
}
function selectPanel() {
  const panels = ['accountsPanel', 'starterPanel', 'credits', 'conversionPanel', 'auditPanel', 'reconcilePanel', 'kieSubmissionsPanel', 'codexPanel'];
  const selected = panels.includes(location.hash.slice(1)) ? location.hash.slice(1) : panels[0];
  for (const id of panels) document.getElementById(id).hidden = id !== selected;
  document.querySelectorAll('.admin-tabs a').forEach(link => link.setAttribute('aria-current', link.hash === '#' + selected ? 'page' : 'false'));
}
window.addEventListener('hashchange', selectPanel);
selectPanel();
const kieStatsDate = value => new Date(value).toLocaleString('ru-RU');
function kieStatsNode(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
const conversionNumber = value => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 4 }).format(value);
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
    ['Доля', `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(stats.ratePercent)}%`],
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
  document.getElementById('roleAudit').replaceChildren(...audit.map(row => { const p = document.createElement('p'); p.textContent = `${new Date(row.created_at).toLocaleString('ru-RU')} · ${row.name}: ${row.old_role} → ${row.new_role} · ${row.reason} · администратор: ${row.actor_id || 'назначение владельца'}`; return p; }));
}
async function loadLedger() {
  const sequence = ++ledgerSequence;
  const accountId = document.getElementById('grantAccount').value;
  if (!accountId) return;
  try {
    const rows = await adminRequest('/api/admin/ledger?account=' + encodeURIComponent(accountId));
    if (sequence !== ledgerSequence) return;
    const names = { grant: 'Начисление', purchase: 'Покупка', reserve: 'Резерв', capture: 'Списание', release: 'Возврат' };
    document.getElementById('creditLedger').replaceChildren(...rows.map(row => { const p = document.createElement('p'); p.textContent = `${new Date(row.created_at).toLocaleString('ru-RU')} · ${names[row.kind] || row.kind} · ${formatCredits(Number(row.amount) / creditScale)} · ${row.note}`; return p; }));
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
