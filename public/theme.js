(() => {
  const STORAGE_KEY = 'ai-media-studio-theme';
  const MOTION_STORAGE_KEY = 'ai-media-boot-motion';
  const LIGHT = 'light';
  const DARK = 'dark';
  const MOTION_ON = 'on';
  const MOTION_OFF = 'off';

  function storedTheme() {
    try {
      const value = localStorage.getItem(STORAGE_KEY);
      return value === LIGHT || value === DARK ? value : null;
    } catch {
      return null;
    }
  }

  function systemTheme() {
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ? LIGHT : DARK;
  }

  function storedMotion() {
    try {
      const value = localStorage.getItem(MOTION_STORAGE_KEY);
      return value === MOTION_ON || value === MOTION_OFF ? value : null;
    } catch {
      return null;
    }
  }

  function systemMotion() {
    return MOTION_ON;
  }

  function currentMotion() {
    const value = document.documentElement.dataset.bootMotion;
    return value === MOTION_ON || value === MOTION_OFF ? value : storedMotion() || systemMotion();
  }

  function currentTheme() {
    const value = document.documentElement.dataset.theme;
    return value === LIGHT || value === DARK ? value : storedTheme() || systemTheme();
  }

  function updateControls(theme) {
    const light = theme === LIGHT;
    document.querySelectorAll('[data-theme-toggle]').forEach(button => {
      button.setAttribute('aria-label', light ? 'Включить тёмную тему' : 'Включить светлую тему');
      button.setAttribute('title', light ? 'Тёмная тема' : 'Светлая тема');
      button.setAttribute('aria-pressed', String(light));
    });
  }

  function updateThemeColor(theme) {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === LIGHT ? '#f7f5f0' : '#090909');
  }

  function updateMotionControls(motion) {
    const enabled = motion === MOTION_ON;
    document.querySelectorAll('[data-boot-motion-toggle]').forEach(button => {
      button.textContent = enabled ? 'Анимация: включена' : 'Анимация: выключена';
      button.setAttribute('aria-label', enabled ? 'Выключить анимацию загрузки' : 'Включить анимацию загрузки');
      button.setAttribute('title', enabled ? 'Выключить анимацию' : 'Включить анимацию');
      button.setAttribute('aria-pressed', String(enabled));
    });
  }

  function applyTheme(theme, persist = false) {
    const next = theme === LIGHT ? LIGHT : DARK;
    document.documentElement.dataset.theme = next;
    document.documentElement.style.colorScheme = next;
    updateThemeColor(next);
    updateControls(next);
    if (persist) {
      try { localStorage.setItem(STORAGE_KEY, next); } catch { /* The selected theme still applies for this page. */ }
    }
    window.dispatchEvent(new CustomEvent('ai-media-theme-change', { detail: { theme: next } }));
    return next;
  }

  function toggleTheme() {
    return applyTheme(currentTheme() === DARK ? LIGHT : DARK, true);
  }

  function applyMotion(motion, persist = false) {
    const next = motion === MOTION_OFF ? MOTION_OFF : MOTION_ON;
    document.documentElement.dataset.bootMotion = next;
    updateMotionControls(next);
    if (persist) {
      try { localStorage.setItem(MOTION_STORAGE_KEY, next); } catch { /* The selected motion still applies for this page. */ }
    }
    return next;
  }

  function toggleMotion() {
    return applyMotion(currentMotion() === MOTION_ON ? MOTION_OFF : MOTION_ON, true);
  }

  const initialStoredTheme = storedTheme();
  applyTheme(initialStoredTheme || systemTheme());
  applyMotion(storedMotion() || systemMotion());

  document.addEventListener('click', event => {
    if (event.target.closest?.('[data-theme-toggle]')) toggleTheme();
    if (event.target.closest?.('[data-boot-motion-toggle]')) toggleMotion();
  });
  document.addEventListener('DOMContentLoaded', () => { updateControls(currentTheme()); updateMotionControls(currentMotion()); }, { once: true });
  window.addEventListener('storage', event => {
    if (event.key === STORAGE_KEY && (event.newValue === LIGHT || event.newValue === DARK)) applyTheme(event.newValue);
    if (event.key === MOTION_STORAGE_KEY && (event.newValue === MOTION_ON || event.newValue === MOTION_OFF)) applyMotion(event.newValue);
  });
  window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', event => {
    if (!storedTheme()) applyTheme(event.matches ? LIGHT : DARK);
  });
  window.AiMediaTheme = { apply: theme => applyTheme(theme, true), current: currentTheme, toggle: toggleTheme };
  window.AiMediaMotion = { apply: motion => applyMotion(motion, true), current: currentMotion, toggle: toggleMotion };
})();
