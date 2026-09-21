<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import landingDocument from '../../../public/landing.html?raw';

const props = defineProps<{ active: boolean }>();
const emit = defineEmits<{ studio: []; home: [] }>();
const root = ref<HTMLElement | null>(null);
const start = landingDocument.indexOf('<a class="skip-link"');
const end = landingDocument.lastIndexOf('</body>');
const markup = landingDocument.slice(start, end);

type ThemeBridge = { current: () => 'light' | 'dark'; apply: (theme: 'light' | 'dark') => void };

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
      ? new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(builtAt).replace(',', '')
      : null;
    const label = `${release.channel === 'debug' ? 'DEBUG · ' : ''}Версия ${release.version}${date ? ` · ${date}` : ''} · сборка ${release.build}`;
    const node = root.value?.querySelector<HTMLElement>('#appVersion');
    if (node) node.textContent = label;
  } catch { /* The public page stays usable when release metadata is unavailable. */ }
}

watch(() => props.active, applySurface, { immediate: true, flush: 'sync' });
onMounted(() => { void updateVersion(); });
onBeforeUnmount(() => applySurface(false));
</script>

<template>
  <div ref="root" class="public-landing" @click="handleClick" v-html="markup"></div>
</template>
