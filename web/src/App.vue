<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import Sidebar from './components/Sidebar.vue';
import Composer from './components/Composer.vue';
import ChatResults from './components/ChatResults.vue';
import HistoryPage from './components/HistoryPage.vue';
import HomePage from './components/HomePage.vue';
import LandingPage from './components/LandingPage.vue';
import QueuePanel from './components/QueuePanel.vue';
import ResultPanel from './components/ResultPanel.vue';
import AccountMenu from './components/AccountMenu.vue';
import HeaderAccountActions from './components/HeaderAccountActions.vue';
import LocaleSwitcher from './components/LocaleSwitcher.vue';
import { getStartupStatus, setAccountContext, subscribeToChanges } from './api/client';
import { mediaModelBrandId, modelBrand } from './domain/model-catalog';
import { useI18n } from './i18n';
import { useStudioStore } from './stores/studio';
import type { GenerationRecord } from './types';

const studio = useStudioStore();
const { t } = useI18n();
const rightOpen = ref(false);
type AppSection = 'landing' | 'home' | 'workspace' | 'history';
const sectionFromPath = (): AppSection => window.location.pathname === '/' || window.location.pathname === '/index.html' ? 'landing' : window.location.pathname === '/app/home' ? 'home' : window.location.pathname.includes('/history') ? 'history' : 'workspace';
const activeSection = ref<AppSection>(sectionFromPath());
const initialReady = ref(false);
const sessionAuthenticated = ref(false);
const mobileView = ref<'chats' | 'workspace' | 'results'>('workspace');
const activeChatName = computed(() => studio.activeChatId === 'system:recent' ? t('navigation.earlier') : studio.chats.find(chat => chat.id === studio.activeChatId)?.name || t('navigation.newChat'));
const showPromptSuggestions = computed(() => {
  const activeChat = studio.chats.find(chat => chat.id === studio.activeChatId);
  return studio.activeChatId !== 'system:recent' && Boolean(activeChat)
    && (activeChat?.materialCount || 0) === 0 && studio.visibleRecords.length === 0;
});
const modeLabels = { text: 'Text → Text', image: 'Text → Image', video: 'Text → Video', audio: 'Text → Audio' } as const;
const promptSuggestions = computed(() => ({
  text: [
    ['Текст для публикации', 'Напиши выразительный текст для публикации в социальных сетях с ясным вступлением и сильным завершением.'],
    ['Улучшить промпт', 'Улучши мой промпт: сделай его конкретным, структурированным и пригодным для качественной генерации.'],
    ['Идеи и концепции', 'Предложи шесть разных креативных концепций для моей задачи и кратко объясни сильную сторону каждой.'],
    ['Редактура текста', 'Отредактируй текст: сохрани смысл и голос автора, убери повторы и сделай формулировки точнее.'],
    ['Сценарий ролика', 'Напиши короткий динамичный сценарий ролика с сильным первым кадром, развитием и финальным призывом.'],
    ['Структура проекта', 'Составь понятную структуру проекта: цель, аудитория, ключевые этапы, риски и критерии готовности.'],
  ],
  image: [
    ['Фотореалистичный портрет', 'Фотореалистичный редакционный портрет, естественная кожа, мягкий кинематографичный свет, высокая детализация.'],
    ['Логотип и брендинг', 'Минималистичный знак для современного бренда, чистая геометрия, выразительный силуэт, премиальная подача.'],
    ['Аниме-иллюстрация', 'Выразительная аниме-иллюстрация с динамичной композицией, чистым контуром и атмосферным освещением.'],
    ['Контент для соцсетей', 'Стильный визуал для социальных сетей, сильный фокусный объект, современная композиция, место для текста.'],
    ['Киберпанк-сцена', 'Кинематографичная киберпанк-сцена ночью, неоновые отражения, объёмный туман и драматичная перспектива.'],
    ['Арт и иллюстрация', 'Авторская цифровая иллюстрация, выразительная палитра, богатые детали и цельная художественная стилистика.'],
  ],
  video: [
    ['Кинематографичная сцена', 'Кинематографичный кадр с плавным движением камеры, естественной глубиной и атмосферным светом.'],
    ['Реклама продукта', 'Короткий премиальный рекламный ролик продукта, чистый фон, эффектный свет и плавное движение камеры.'],
    ['Оживить изображение', 'Оживи исходное изображение деликатным естественным движением, сохранив композицию и черты персонажа.'],
    ['Контент для соцсетей', 'Динамичный вертикальный ролик для социальных сетей с сильным первым кадром и быстрым развитием.'],
    ['Плавный пролёт камеры', 'Плавный кинематографичный пролёт камеры сквозь сцену с реалистичным параллаксом и глубиной.'],
    ['Атмосферный кадр', 'Медленный атмосферный кадр с мягким движением среды, объёмным светом и выразительным настроением.'],
  ],
  audio: [
    ['Закадровый голос', 'Естественная уверенная озвучка с ясной дикцией, спокойным темпом и тёплой интонацией.'],
    ['Музыкальная тема', 'Короткая запоминающаяся музыкальная тема с современным звучанием и выразительным развитием.'],
    ['Звуковая атмосфера', 'Объёмная звуковая атмосфера пространства с реалистичными деталями и мягкой динамикой.'],
    ['Джингл бренда', 'Короткий узнаваемый аудиоджингл для современного бренда, чистый и уверенный финал.'],
    ['Звук для ролика', 'Динамичное звуковое оформление короткого ролика с акцентами на ключевых переходах.'],
    ['Спокойный фон', 'Ненавязчивый спокойный фон для речи, без резких пиков и отвлекающих музыкальных элементов.'],
  ],
}[studio.mode]));
const welcomeModel = computed(() => {
  if (studio.provider === 'codex') {
    const model = studio.currentCodexModel;
    return { name: model?.name || (studio.isAdmin ? 'Codex' : t('provider.aiModel')), provider: studio.isAdmin ? 'Codex' : t('provider.aiModels'), brand: modelBrand('codex') };
  }
  const model = studio.currentMediaModel;
  const provider = studio.isAdmin ? (studio.catalog?.providers.find(item => item.id === model?.providerId)?.name || 'Kie.ai') : t('provider.mediaModels');
  const brandId = model ? mediaModelBrandId(model.id, model.name) : 'other';
  return { name: model?.name || t('provider.selectModel'), provider, brand: modelBrand(brandId) };
});
const startupTitle = computed(() => studio.databaseState === 'unavailable'
  ? t('boot.databaseRecovering')
  : studio.databaseState === 'connecting'
    ? t('boot.databaseChecking')
    : t('boot.workspace'));
let unsubscribe: (() => void) | null = null;
let eventStreamReady = false;
let studioInitialization: Promise<boolean> | null = null;

function startLiveUpdates() {
  if (unsubscribe || !studio.accountReady) return;
  unsubscribe = subscribeToChanges(event => {
    if (event === 'ready' && !eventStreamReady) {
      eventStreamReady = true;
      return;
    }
    void Promise.all([event === 'reset' ? studio.refreshFull() : studio.refresh(), studio.refreshAccess()]).catch(() => {});
  });
}

async function ensureStudio() {
  if (studio.accountReady) return true;
  if (!studioInitialization) {
    studioInitialization = studio.initialize().then(() => {
      sessionAuthenticated.value = studio.accountReady;
      startLiveUpdates();
      return studio.accountReady;
    }).finally(() => { studioInitialization = null; });
  }
  return studioInitialization;
}

async function discoverLandingSession() {
  const accountId = document.querySelector('meta[name="account-id"]')?.getAttribute('content') || '';
  const accountRole = document.querySelector('meta[name="account-role"]')?.getAttribute('content') || '';
  if (accountId && accountId !== 'pending' && accountRole && accountRole !== 'pending') {
    sessionAuthenticated.value = true;
    await ensureStudio();
    return;
  }
  try {
    const status = await getStartupStatus();
    sessionAuthenticated.value = status.authenticated;
    if (status.authenticated && status.account) {
      setAccountContext(status.account);
      await ensureStudio();
    }
  } catch { /* The public landing is independent from account startup. */ }
}

function showLanding() {
  navigate('landing');
  rightOpen.value = false;
}

function showHistory() {
  navigate('history');
  rightOpen.value = false;
  mobileView.value = 'workspace';
}

async function showWorkspace() {
  if (!studio.accountReady) {
    if (!sessionAuthenticated.value) {
      window.location.assign('/login');
      return;
    }
    if (!await ensureStudio()) return;
  }
  navigate('workspace');
  rightOpen.value = false;
  mobileView.value = 'workspace';
}

function showHome() {
  navigate('home');
  rightOpen.value = false;
  mobileView.value = 'workspace';
}

function navigate(section: AppSection, replace = false) {
  activeSection.value = section;
  const path = section === 'landing' ? '/' : section === 'home' ? '/app/home' : section === 'history' ? '/app/history' : '/app';
  if (window.location.pathname !== path) window.history[replace ? 'replaceState' : 'pushState']({ section }, '', path);
}

function handlePopState() {
  activeSection.value = sectionFromPath();
  rightOpen.value = false;
  if (activeSection.value !== 'landing' && !studio.accountReady) void ensureStudio();
}

function usePromptSuggestion(prompt: string) {
  studio.prompt = prompt;
  void nextTick(() => document.querySelector<HTMLTextAreaElement>('.composer-body textarea')?.focus());
}

function selectResult(id: string) {
  studio.select(id);
  if (window.matchMedia('(max-width: 720px)').matches) mobileView.value = 'results';
  else if (window.matchMedia('(max-width: 1050px)').matches) rightOpen.value = true;
}

function selectHistoryResult(record: GenerationRecord) {
  studio.selectChat(record.chatId || 'system:recent');
  studio.select(record.id);
  if (activeSection.value === 'history') return;
  if (window.matchMedia('(max-width: 720px)').matches) mobileView.value = 'results';
  else if (window.matchMedia('(max-width: 1050px)').matches) rightOpen.value = true;
}

onMounted(async () => {
  window.addEventListener('popstate', handlePopState);
  if (activeSection.value === 'landing') await discoverLandingSession();
  else await ensureStudio();
  initialReady.value = true;
});

onBeforeUnmount(() => {
  unsubscribe?.();
  window.removeEventListener('popstate', handlePopState);
  studio.stopCodexPolling();
  studio.stopMediaPolling();
  studio.stopStartupPolling();
});
</script>

<template>
  <div v-if="!initialReady || (activeSection !== 'landing' && !studio.accountReady)" class="site-boot-screen" role="status" aria-live="polite" :aria-label="t('boot.aria')">
    <div class="site-boot-rings" aria-hidden="true"><span></span><span></span><span></span></div>
    <div class="site-boot-content"><img class="site-boot-logo" src="/brand-logo.png" alt="AI Media Client"><span class="site-boot-line"></span><p>{{ startupTitle }}</p><small>{{ studio.providerReadiness === 'checking' ? t('boot.services') : t('boot.necessaryData') }}</small><button v-if="studio.error" type="button" @click="studio.initialize">{{ t('common.retry') }}</button></div>
  </div>
  <LandingPage v-show="initialReady && activeSection === 'landing'" :active="activeSection === 'landing'" :authenticated="sessionAuthenticated" :account-ready="studio.accountReady" @home="showLanding" @studio="showWorkspace" @history="showHistory" />
  <div v-show="initialReady && activeSection !== 'landing' && studio.accountReady" class="studio-app" :class="[`mobile-view-${mobileView}`, { 'right-panel-open': rightOpen }]">
    <Sidebar :active-section="activeSection" @landing="showLanding" @home="showHome" @workspace="showWorkspace" @history="showHistory" />
    <main class="studio-main">
      <header class="studio-header"><div><span class="eyebrow">{{ activeSection === 'home' ? 'AI MEDIA CLIENT' : activeSection === 'history' ? t('navigation.resultsLibrary') : t('navigation.currentChat', { name: activeChatName }) }}</span><h1>{{ activeSection === 'home' ? t('navigation.home') : activeSection === 'history' ? t('navigation.history') : t('navigation.generation') }}</h1></div><div class="header-actions"><LocaleSwitcher /><HeaderAccountActions :ready="studio.accountReady" @select-notification="selectHistoryResult" /><button v-if="activeSection !== 'home'" type="button" class="results-toggle" @click="rightOpen = true">{{ t('navigation.queueAndResults') }}</button><AccountMenu :ready="studio.accountReady" @history="showHistory" /></div></header>
      <div class="studio-grid" :class="{ 'history-mode': activeSection === 'history', 'home-mode': activeSection === 'home' }"><HomePage v-if="activeSection === 'home'" @workspace="showWorkspace" /><HistoryPage v-else-if="activeSection === 'history'" @select="selectHistoryResult" @workspace="showWorkspace" /><div v-else class="studio-center" :class="{ 'has-chat-results': studio.visibleRecords.length }"><section class="welcome" :class="{ 'welcome-compact': studio.visibleRecords.length }" :aria-label="t('provider.currentModel')"><span class="welcome-model-icon" :style="{ '--brand-accent': welcomeModel.brand.accent }"><img v-if="welcomeModel.brand.icon" :src="welcomeModel.brand.icon" alt=""><span v-else>{{ welcomeModel.brand.label.slice(0, 1) }}</span></span><h2>{{ welcomeModel.name }}</h2><p>{{ welcomeModel.provider }} · {{ modeLabels[studio.mode] }}</p><div v-if="showPromptSuggestions" class="welcome-suggestions" :aria-label="t('provider.promptIdeas')"><button v-for="suggestion in promptSuggestions" :key="suggestion[0]" type="button" @click="usePromptSuggestion(suggestion[1])">{{ suggestion[0] }}</button></div></section><ChatResults v-show="studio.visibleRecords.length" @select="selectResult" /><Composer /></div><div v-if="activeSection === 'workspace'" class="studio-right"><button type="button" class="right-close" :aria-label="t('provider.closeResults')" @click="rightOpen = false">×</button><QueuePanel /><ResultPanel @history="showHistory" @workspace="showWorkspace" /></div></div>
    </main>
    <nav class="mobile-nav" :aria-label="t('navigation.sections')"><button type="button" :class="{ active: mobileView === 'chats' }" @click="mobileView = 'chats'">{{ t('navigation.chats') }}</button><button type="button" :class="{ active: mobileView === 'workspace' }" @click="mobileView = 'workspace'">{{ t('navigation.work') }}</button><button type="button" :class="{ active: mobileView === 'results' }" @click="mobileView = 'results'">{{ t('navigation.results') }}</button></nav>
  </div>
</template>
