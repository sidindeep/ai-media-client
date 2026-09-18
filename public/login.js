async function loadLogin() {
  const status = document.getElementById('loginStatus');
  try {
    const response = await fetch('/auth/providers');
    if (!response.ok) throw new Error();
    const { result } = await response.json();
    for (const provider of result) {
      const link = document.createElement('a'); link.className = 'account-button';
      link.href = `/auth/${encodeURIComponent(provider.id)}/start`; link.textContent = `Продолжить с ${provider.label}`;
      document.getElementById('loginProviders').append(link);
    }
    status.textContent = new URLSearchParams(location.search).has('error') ? 'Вход не завершён. Попробуйте ещё раз.' : result.length ? '' : 'Способы входа ещё не настроены администратором.';
  } catch { status.textContent = 'Сервис входа недоступен. Повторите позже.'; }
}
void loadLogin();
