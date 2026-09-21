(() => {
  const STORAGE_KEY = 'ai-media-studio-theme';
  const LIGHT = 'light';
  const DARK = 'dark';

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

  const initialStoredTheme = storedTheme();
  applyTheme(initialStoredTheme || systemTheme());

  document.addEventListener('click', event => {
    if (event.target.closest?.('[data-theme-toggle]')) toggleTheme();
  });
  document.addEventListener('DOMContentLoaded', () => updateControls(currentTheme()), { once: true });
  window.addEventListener('storage', event => {
    if (event.key === STORAGE_KEY && (event.newValue === LIGHT || event.newValue === DARK)) applyTheme(event.newValue);
  });
  window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', event => {
    if (!storedTheme()) applyTheme(event.matches ? LIGHT : DARK);
  });

  window.AiMediaTheme = { apply: theme => applyTheme(theme, true), current: currentTheme, toggle: toggleTheme };
})();
