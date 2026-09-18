let grantReference = crypto.randomUUID();
void fetch('/api/version', { cache: 'no-store' }).then(async response => {
  if (!response.ok) throw new Error('version unavailable');
  const release = await response.json();
  document.getElementById('appVersion').textContent = `Версия ${release.version} · сборка ${release.build} · ${release.builtAt ? new Date(release.builtAt).toLocaleString('ru-RU') : 'запуск из исходников'}`;
}).catch(() => { document.getElementById('appVersion').textContent = 'Версия сервера недоступна — проверьте обновление приложения.'; });
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
  const panels = ['accountsPanel', 'credits', 'auditPanel', 'reconcilePanel', 'codexPanel'];
  const selected = panels.includes(location.hash.slice(1)) ? location.hash.slice(1) : panels[0];
  for (const id of panels) document.getElementById(id).hidden = id !== selected;
  document.querySelectorAll('.admin-tabs a').forEach(link => link.setAttribute('aria-current', link.hash === '#' + selected ? 'page' : 'false'));
}
window.addEventListener('hashchange', selectPanel);
selectPanel();
function renderAccounts() {
  const search = document.getElementById('accountSearch').value.trim().toLowerCase();
  const rows = accountRows.filter(row => [row.name, row.email, row.id].join(' ').toLowerCase().includes(search));
  document.getElementById('accounts').replaceChildren(...rows.map(row => {
    const card = document.createElement('article'); card.className = 'admin-account-row';
    const info = document.createElement('div'), link = document.createElement('a'), detail = document.createElement('p');
    link.href = `/?account=${row.id}`; link.textContent = row.name;
    detail.textContent = `${row.email || row.id} · ${row.role === 'admin' ? 'Администратор' : 'Пользователь'} · доступно ${formatCredits((Number(row.balance) - Number(row.held)) / creditScale)} кредитов`;
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
