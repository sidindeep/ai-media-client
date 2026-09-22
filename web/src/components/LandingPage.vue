<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import landingDocument from '../../../public/landing.html?raw';
import AccountMenu from './AccountMenu.vue';
import LocaleSwitcher from './LocaleSwitcher.vue';
import { useI18n } from '../i18n';

const props = defineProps<{ active: boolean; authenticated: boolean; accountReady: boolean }>();
const emit = defineEmits<{ studio: []; home: []; history: [] }>();
const root = ref<HTMLElement | null>(null);
const { formatDate, locale, localizeElement, t } = useI18n();
const start = landingDocument.indexOf('<a class="skip-link"');
const end = landingDocument.lastIndexOf('</body>');
const markup = landingDocument.slice(start, end);

type ThemeBridge = { current: () => 'light' | 'dark'; apply: (theme: 'light' | 'dark') => void };
type MotionBridge = { current: () => 'on' | 'off' };

function landingStyles() {
  let link = document.querySelector<HTMLLinkElement>('link[data-landing-styles]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/landing.css';
    link.dataset.landingStyles = '';
    document.head.append(link);
  }
  return link;
}

function applySurface(active: boolean) {
  landingStyles().media = active ? 'all' : 'not all';
  document.body.classList.toggle('public-landing-active', active);
  if (active) {
    const theme = (window as Window & { AiMediaTheme?: ThemeBridge }).AiMediaTheme;
    if (theme) theme.apply(theme.current());
  }
  void nextTick().then(() => syncHeroVideo());
}

function syncAccountAction() {
  const login = root.value?.querySelector<HTMLAnchorElement>('.landing-login-link');
  if (login) login.hidden = props.authenticated;
}

function translateLanding() {
  if (!root.value) return;
  localizeElement(root.value);
  syncLocalizedControls();
  document.title = t('landing.metaTitle');
  document.querySelector<HTMLMetaElement>('meta[name="description"]')?.setAttribute('content', t('landing.metaDescription'));
}

function syncLocalizedControls() {
  const theme = (window as Window & { AiMediaTheme?: ThemeBridge }).AiMediaTheme?.current();
  root.value?.querySelectorAll<HTMLElement>('[data-theme-toggle]').forEach(button => {
    const nextIsDark = theme === 'light';
    button.setAttribute('aria-label', t(nextIsDark ? 'theme.enableDark' : 'theme.enableLight'));
    button.setAttribute('title', t(nextIsDark ? 'theme.dark' : 'theme.light'));
  });
  const motion = (window as Window & { AiMediaMotion?: MotionBridge }).AiMediaMotion?.current();
  root.value?.querySelectorAll<HTMLElement>('[data-hero-motion-toggle]').forEach(button => {
    const enabled = motion !== 'off';
    const label = button.querySelector<HTMLElement>('[data-hero-motion-label]');
    if (label) label.textContent = t(enabled ? 'landing.pauseVideo' : 'landing.enableVideo');
    button.setAttribute('aria-label', t(enabled ? 'landing.pauseBackgroundVideo' : 'landing.enableBackgroundVideo'));
    button.setAttribute('title', t(enabled ? 'landing.pauseVideo' : 'landing.enableVideo'));
  });
}

function syncHeroVideo(event?: Event) {
  const detail = event instanceof CustomEvent ? event.detail as { motion?: 'on' | 'off' } : undefined;
  const motion = detail?.motion ?? (window as Window & { AiMediaMotion?: MotionBridge }).AiMediaMotion?.current();
  const video = root.value?.querySelector<HTMLVideoElement>('[data-hero-video]');
  if (!video) return;
  syncLocalizedControls();
  if (!props.active || motion === 'off') {
    video.pause();
    return;
  }
  void video.play().catch(() => { /* The poster remains visible when autoplay is unavailable. */ });
}

function handleClick(event: MouseEvent) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[href]');
  if (!link) return;
  const destination = new URL(link.href, window.location.href);
  if (destination.origin !== window.location.origin) return;
  if (destination.pathname === '/app' && !destination.search && !destination.hash) {
    event.preventDefault();
    emit('studio');
    return;
  }
  if (destination.pathname === '/' && !destination.search && !destination.hash) {
    event.preventDefault();
    emit('home');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  if (destination.pathname !== '/' || !destination.hash) return;
  const target = root.value?.querySelector<HTMLElement>(`#${CSS.escape(decodeURIComponent(destination.hash.slice(1)))}`);
  if (!target) return;
  event.preventDefault();
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (window.location.hash !== destination.hash) history.replaceState(history.state, '', destination.hash);
}

async function updateVersion() {
  try {
    const release = await fetch('/api/version', { cache: 'no-store' }).then(response => response.json());
    await nextTick();
    const builtAt = release.builtAt ? new Date(release.builtAt) : null;
    const date = builtAt && !Number.isNaN(builtAt.getTime())
      ? formatDate(builtAt, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).replace(',', '')
      : null;
    const label = `${release.channel === 'debug' ? 'DEBUG · ' : ''}${t('landing.version', { version: release.version, date: date ? ` · ${date}` : '', build: release.build })}`;
    const node = root.value?.querySelector<HTMLElement>('#appVersion');
    if (node) node.textContent = label;
  } catch { /* The public page stays usable when release metadata is unavailable. */ }
}

watch(() => props.active, applySurface, { immediate: true, flush: 'sync' });
watch(() => props.authenticated, () => { void nextTick().then(syncAccountAction); }, { immediate: true });
watch(locale, () => { void nextTick().then(() => { translateLanding(); void updateVersion(); }); });
onMounted(() => {
  window.addEventListener('ai-media-motion-change', syncHeroVideo);
  window.addEventListener('ai-media-theme-change', syncLocalizedControls);
  void updateVersion();
  syncAccountAction();
  translateLanding();
  syncHeroVideo();
});
onBeforeUnmount(() => {
  window.removeEventListener('ai-media-motion-change', syncHeroVideo);
  window.removeEventListener('ai-media-theme-change', syncLocalizedControls);
  applySurface(false);
});
</script>

<template>
  <div class="landing-surface">
    <div ref="root" class="public-landing" :class="{ 'is-authenticated': authenticated }" @click="handleClick" v-html="markup"></div>
    <Teleport defer to=".landing-language-slot"><LocaleSwitcher /></Teleport>
    <Teleport v-if="authenticated" defer to=".landing-account-slot">
      <AccountMenu :ready="accountReady" @history="emit('history')" />
    </Teleport>
  </div>
</template>
