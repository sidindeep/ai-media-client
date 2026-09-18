(() => {
  const mount = document.getElementById('accountMenuMount');
  if (!mount) return;
  mount.innerHTML = `<details class="account-dropdown" id="accountDropdown">
    <summary aria-label="Меню аккаунта"><span class="account-avatar" id="accountAvatar">•</span><span id="accountName">Аккаунт</span><span>⌄</span></summary>
    <div class="account-popover"><strong id="menuName"></strong><span id="menuRole" class="hint"></span>
      <div class="menu-credit-row"><span>Кредиты</span><b id="menuBalance">—</b></div>
      <button id="menuTopup" class="primary" type="button">＋ Пополнить</button>
      <hr><button id="menuProfile" type="button">Аккаунт</button><a id="menuHistory" href="/?view=history">История</a>
      <button id="menuSettings" type="button">Настройки</button><a id="menuAdmin" href="/admin.html" hidden>Администрирование</a>
      <hr><button id="logout" type="button">Выйти</button><p id="menuStatus" role="status"></p>
    </div></details>
    <dialog id="accountDialog" class="studio-dialog"><div class="dialog-heading"><h2 id="accountDialogTitle">Аккаунт</h2><button id="closeAccountDialog" type="button" aria-label="Закрыть">×</button></div>
      <form id="profileForm"><label>Имя<input id="profileName" maxlength="200" required></label><p id="profileIdentity" class="hint"></p><button type="submit">Сохранить имя</button></form>
      <form id="accountSettingsForm" hidden><label class="check"><input id="accountAutoSave" type="checkbox">Сохранять готовые файлы на сервере</label><label>Одновременно генераций<select id="accountConcurrency"><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option></select></label><button type="submit">Сохранить настройки</button></form>
      <p id="topupInfo" hidden>Покупка кредитов пока не подключена. Для пополнения обратитесь к администратору.</p><p id="accountDialogStatus" role="status"></p>
    </dialog>`;
  const el = id => document.getElementById(id);
  let account;
  const ready = fetch('/api/account').then(async response => {
    if (!response.ok) throw new Error('Войдите в аккаунт');
    account = (await response.json()).result; render(); return account;
  });
  function render() {
    el('accountName').textContent = el('menuName').textContent = account.name;
    el('accountAvatar').textContent = account.name.slice(0, 1).toUpperCase();
    el('menuRole').textContent = account.role === 'admin' ? 'Администратор' : 'Пользователь';
    el('menuBalance').textContent = account.wallet ? new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 }).format(account.wallet.balance) : '—';
    el('menuAdmin').hidden = account.role !== 'admin' || account.id === 'local';
    if (el('adminLink')) el('adminLink').hidden = el('menuAdmin').hidden;
    el('logout').hidden = account.id === 'local';
  }
  async function request(url, body) {
    await ready;
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Media-Client': 'web', 'X-Media-User': account.id }, body: JSON.stringify(body) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error); return data.result;
  }
  function open(section, title) {
    el('accountDropdown').open = false;
    for (const id of ['profileForm', 'accountSettingsForm', 'topupInfo']) el(id).hidden = id !== section;
    el('accountDialogTitle').textContent = title; el('accountDialogStatus').textContent = '';
    el('accountDialog').showModal();
  }
  const fail = error => { el('accountDialogStatus').textContent = el('menuStatus').textContent = error.message; };
  el('accountDropdown').addEventListener('toggle', async () => {
    if (!el('accountDropdown').open) return;
    try { await ready; const response = await fetch('/api/account'); if (!response.ok) throw new Error('Сессия завершена'); account = (await response.json()).result; render(); } catch (error) { fail(error); }
  });
  document.addEventListener('click', event => { if (!mount.contains(event.target)) el('accountDropdown').open = false; });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') el('accountDropdown').open = false; });
  el('closeAccountDialog').onclick = () => el('accountDialog').close();
  el('menuProfile').onclick = async () => {
    try { await ready; el('profileName').value = account.name;
      el('profileIdentity').textContent = [...account.identities.map(i => i.email || `${i.provider}: ${i.subject}`), `ID: ${account.id}`].join(' · ');
      open('profileForm', 'Аккаунт');
    } catch (error) { fail(error); }
  };
  el('menuSettings').onclick = async () => {
    try { const [storage, queue] = await Promise.all([request('/api/rpc/storageSettings', []), request('/api/rpc/queueStatus', [])]);
      el('accountAutoSave').checked = storage.autoSave; el('accountConcurrency').value = queue.concurrency; open('accountSettingsForm', 'Настройки');
    } catch (error) { fail(error); }
  };
  el('menuTopup').onclick = async () => { try { await ready; if (account.role === 'admin') location.assign('/admin.html#credits'); else open('topupInfo', 'Пополнение кредитов'); } catch (error) { fail(error); } };
  el('menuHistory').onclick = event => { if (el('tabHistory')) { event.preventDefault(); el('tabHistory').click(); el('accountDropdown').open = false; } };
  el('profileForm').onsubmit = async event => {
    event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
    try { const saved = await request('/api/account/profile', { name: el('profileName').value }); account.name = saved.name; render(); el('accountDialogStatus').textContent = 'Имя сохранено'; }
    catch (error) { fail(error); } finally { button.disabled = false; }
  };
  el('accountSettingsForm').onsubmit = async event => {
    event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
    try { await request('/api/rpc/setAutoSave', [el('accountAutoSave').checked]); await request('/api/rpc/setConcurrency', [Number(el('accountConcurrency').value)]);
      if (!new URLSearchParams(location.search).get('account')) {
        if (el('autoSave')) el('autoSave').checked = el('accountAutoSave').checked;
        if (el('queueConcurrency')) el('queueConcurrency').value = el('accountConcurrency').value;
      }
      el('accountDialogStatus').textContent = 'Настройки сохранены';
    } catch (error) { fail(error); } finally { button.disabled = false; }
  };
  el('logout').onclick = async () => { try { await request('/auth/logout', {}); location.assign('/login'); } catch (error) { fail(error); } };
  if (new URLSearchParams(location.search).get('view') === 'history') window.addEventListener('load', () => el('tabHistory')?.click());
  void ready.catch(fail);
})();
