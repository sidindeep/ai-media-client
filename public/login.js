(() => {
  const providers = document.getElementById('loginProviders');
  const status = document.getElementById('loginStatus');
  const emailSection = document.getElementById('emailSection');
  const emailStatus = document.getElementById('emailStatus');
  const form = document.getElementById('emailForm');
  const emailInput = document.getElementById('loginEmail');
  const passwordInput = document.getElementById('loginPassword');
  const submit = document.getElementById('emailSubmit');
  const prompt = document.getElementById('emailPrompt');
  const modeAction = document.getElementById('emailModeAction');
  const forgot = document.getElementById('forgotAction');
  const params = new URLSearchParams(location.search);
  let mode = params.has('reset') ? 'reset' : 'login';

  function renderMode() {
    const reset = mode === 'reset';
    const forgotMode = mode === 'forgot';
    emailInput.hidden = reset;
    document.getElementById('emailLabel').hidden = reset;
    passwordInput.closest('#passwordField').hidden = forgotMode;
    document.getElementById('passwordLabel').hidden = forgotMode;
    forgot.hidden = mode !== 'login';
    emailInput.required = !reset;
    passwordInput.required = !forgotMode;
    passwordInput.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    submit.textContent = mode === 'register' ? 'Зарегистрироваться' : reset ? 'Сохранить пароль' : forgotMode ? 'Отправить ссылку' : 'Войти →';
    prompt.textContent = mode === 'login' ? 'Нет аккаунта?' : 'Уже есть аккаунт?';
    modeAction.textContent = mode === 'login' ? 'Зарегистрироваться' : 'Войти';
    emailStatus.textContent = '';
  }
  modeAction.addEventListener('click', () => { mode = mode === 'login' ? 'register' : 'login'; renderMode(); });
  forgot.addEventListener('click', () => { mode = 'forgot'; renderMode(); emailInput.focus(); });
  document.getElementById('showPassword').addEventListener('click', () => {
    const shown = passwordInput.type === 'text';
    passwordInput.type = shown ? 'password' : 'text';
    document.getElementById('showPassword').setAttribute('aria-label', shown ? 'Показать пароль' : 'Скрыть пароль');
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    submit.disabled = true;
    emailStatus.textContent = '';
    try {
      const body = mode === 'reset' ? { token: params.get('reset'), password: passwordInput.value }
        : mode === 'forgot' ? { email: emailInput.value }
          : { email: emailInput.value, password: passwordInput.value };
      const response = await fetch(`/auth/email/${mode}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Вход не выполнен');
      if (mode === 'login') { location.assign('/app'); return; }
      if (mode === 'reset') {
        history.replaceState(null, '', '/login');
        params.delete('reset');
        mode = 'login';
        renderMode();
        emailStatus.textContent = 'Пароль изменён. Теперь войдите.';
      } else {
        emailStatus.textContent = mode === 'register' ? 'Проверьте почту и подтвердите адрес по ссылке.' : 'Если аккаунт существует, письмо со ссылкой отправлено.';
      }
    } catch (error) { emailStatus.textContent = error.message || 'Вход не выполнен'; }
    finally { submit.disabled = false; }
  });
  renderMode();

  async function loadLogin() {
    try {
      const response = await fetch('/auth/providers');
      if (!response.ok) throw new Error();
      const { result } = await response.json();
      for (const provider of result) {
        if (provider.id === 'email') {
          emailSection.hidden = false;
          document.getElementById('oauthRegisterNote').hidden = true;
          continue;
        }
        const link = document.createElement('a');
        link.className = 'account-button';
        link.dataset.provider = provider.id;
        link.href = `/auth/${encodeURIComponent(provider.id)}/start`;
        link.textContent = `Продолжить с ${provider.label}`;
        providers.append(link);
      }
      if (!providers.children.length) providers.hidden = true;
      if (!providers.children.length) emailSection.querySelector('.login-divider').hidden = true;
      status.textContent = params.has('error') ? (params.get('error') === 'verify' ? 'Ссылка подтверждения недействительна или устарела.' : 'Вход не завершён. Попробуйте ещё раз.')
        : result.length ? '' : 'Способы входа ещё не настроены администратором.';
    } catch { status.textContent = 'Сервис входа недоступен. Повторите позже.'; }
  }
  void loadLogin();
})();
