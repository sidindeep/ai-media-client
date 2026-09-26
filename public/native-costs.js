const formatNative = value => new Intl.NumberFormat(document.documentElement.lang, { maximumFractionDigits: 3 }).format(value);
let quoteSequence = 0, quoteTimer;
function recordCostText(record) {
  if (!record.nativeQuote) return 'Стоимость не указана';
  const label = record.state === 'success' ? 'Списано' : ['fail', 'blocked', 'cancelled'].includes(record.state) ? 'Возвращено из резерва' : 'Зарезервировано';
  return `${label}: ${formatNative(record.nativeQuote.credits)} кредитов`;
}
function refreshCostPreview() {
  if (!catalog) return;
  document.querySelectorAll('#fields select').forEach(select => select.syncChoices?.());
  document.querySelectorAll('#fields [data-key="duration"]').forEach(input => input.syncDuration?.());
  const model = selectedModel(), input = {};
  for (const field of model?.fields || []) {
    const element = $('fields').querySelector(`[data-key="${field.key}"]`);
    if (element) input[field.key] = field.type === 'boolean' ? element.checked : element.value;
  }
  const sequence = ++quoteSequence; clearTimeout(quoteTimer);
  $('estimatedCost').textContent = 'Расчёт стоимости…';
  quoteTimer = setTimeout(async () => {
    try {
      const quote = await window.desktop.nativeQuote({ modelId: model.id, input });
      if (sequence === quoteSequence) $('estimatedCost').textContent = `Цена: ${formatNative(quote.credits)} кредитов. Резерв при запуске, списание после успеха.`;
    } catch (error) { if (sequence === quoteSequence) $('estimatedCost').textContent = error.message; }
  }, 200);
}
function renderSpending() {
  const now = new Date(), period = $('spendPeriod').value;
  const records = historyRecords.filter(row => {
    const date = new Date(row.createdAt);
    return period === 'all' || (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && (period === 'month' || date.getDate() === now.getDate()));
  });
  const spent = records.filter(row => row.state === 'success').reduce((sum, row) => sum + (row.nativeQuote?.amountUnits || 0), 0);
  const scale = records.find(row => row.nativeQuote)?.nativeQuote.scale;
  $('spendSummary').textContent = `Списано за генерации всех провайдеров: ${formatNative(scale ? spent / scale : 0)} кредитов. Операции — в журнале ниже.`;
  $('balanceAudit').textContent = 'Покупка кредитов появится позже. Для тестирования обратитесь к администратору.';
  void window.desktop.getBalance().then(wallet => {
    $('balanceAudit').textContent = `Доступно: ${formatNative(wallet.balance)}; в резерве: ${formatNative(wallet.heldUnits / wallet.scale)} кредитов. Покупка появится позже; для тестирования обратитесь к администратору.`;
  }).catch(() => {});
}
async function initCosts() {
  refreshCostPreview(); renderSpending();
  const container = document.getElementById('nativeLedger');
  try {
    const [rows, wallet] = await Promise.all([window.desktop.nativeLedger(), window.desktop.getBalance()]);
    const labels = { grant: 'Начисление', purchase: 'Покупка', reserve: 'Резерв', capture: 'Списание', release: 'Возврат резерва' };
    container.replaceChildren(...rows.map(row => { const p = document.createElement('p'); p.textContent = `${new Date(row.created_at).toLocaleString(document.documentElement.lang)} · ${labels[row.kind]} · ${formatNative(Number(row.amount) / wallet.scale)} кредитов`; return p; }));
  } catch { container.textContent = 'Не удалось загрузить операции'; }
}
document.getElementById('spendPeriod').onchange = renderSpending;
document.addEventListener('input', event => { if (event.target.closest('#fields')) refreshCostPreview(); });
document.addEventListener('change', event => { if (event.target.closest('#fields')) refreshCostPreview(); });
