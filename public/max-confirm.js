(async () => {
  const status = document.getElementById('maxConfirmStatus');
  const initData = new URLSearchParams(location.hash.slice(1)).get('WebAppData');
  if (!initData) { status.textContent = 'Откройте эту страницу через кнопку MAX на странице входа.'; return; }
  history.replaceState(null, '', location.pathname);
  try {
    const response = await fetch('/auth/max/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    status.textContent = 'Вход подтверждён. Вернитесь во вкладку Медиастудии.';
  } catch (error) { status.textContent = error.message || 'Не удалось подтвердить вход через MAX.'; }
})();
