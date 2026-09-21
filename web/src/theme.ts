export type StudioTheme = 'dark' | 'light';

export const STUDIO_THEME_KEY = 'ai-media-studio-theme';

export function preferredStudioTheme(): StudioTheme {
  const stored = localStorage.getItem(STUDIO_THEME_KEY);
  if (stored === 'dark' || stored === 'light') return stored;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function applyStudioTheme(theme: StudioTheme, persist = true) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f7f5f0' : '#090909');
  if (persist) {
    try { localStorage.setItem(STUDIO_THEME_KEY, theme); } catch { /* The theme still applies for this page. */ }
  }
  window.dispatchEvent(new CustomEvent('ai-media-theme-change', { detail: { theme } }));
}

export function initializeStudioTheme() {
  let storedTheme: StudioTheme | null = null;
  try {
    const stored = localStorage.getItem(STUDIO_THEME_KEY);
    storedTheme = stored === 'dark' || stored === 'light' ? stored : null;
  } catch {
    // Fall back to the system preference when storage is unavailable.
  }
  applyStudioTheme(storedTheme ?? preferredStudioTheme(), storedTheme !== null);
}
