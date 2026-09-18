let grantReference = crypto.randomUUID();
const currentAccount = fetch('/api/account').then(response => response.json()).then(body => body.result);
async function adminRequest(url, options) {
  const account = await currentAccount;
  const response = await fetch(url, { ...options, headers: { 'X-Media-Client': 'web', 'X-Media-User': account.id, 'Content-Type': 'application/json' } });
  const body = await response.json(); if (!response.ok) throw new Error(body.error); return body.result;
}
async function loadAccounts() {
  const scale = (await currentAccount).wallet.scale;
  const rows = await adminRequest('/api/admin/accounts');
  document.getElementById('accounts').replaceChildren(...rows.map(row => {
    const p = document.createElement('p'), link = document.createElement('a');
    link.href = `/?account=${row.id}`; link.textContent = row.name;
    p.append(link, ` · ${row.role} · баланс ${Number(row.balance) / scale}, резерв ${Number(row.held) / scale} кредитов · ${row.id}`); return p;
  }));
  const select = document.getElementById('grantAccount'), selected = select.value;
  select.replaceChildren(...rows.map(row => new Option(`${row.name} (${row.id})`, row.id))); select.value = selected || rows[0]?.id || '';
}
document.getElementById('grantForm').onsubmit = async event => {
  event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
  try {
    const scale = (await currentAccount).wallet.scale;
    const credits = Number(document.getElementById('grantAmount').value), amountUnits = Math.round(credits * scale);
    if (Math.abs(amountUnits / scale - credits) > 1e-9) throw new Error('Некорректная точность суммы');
    await adminRequest('/api/admin/grant', { method: 'POST', body: JSON.stringify({ accountId: document.getElementById('grantAccount').value, amountUnits, reference: grantReference, note: document.getElementById('grantNote').value }) });
    grantReference = crypto.randomUUID(); document.getElementById('adminStatus').textContent = 'Начисление сохранено'; await loadAccounts();
  } catch (error) { document.getElementById('adminStatus').textContent = error.message; }
  finally { button.disabled = false; }
};
void loadAccounts().catch(error => { document.getElementById('adminStatus').textContent = error.message; });
