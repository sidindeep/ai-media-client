<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import Sidebar from './components/Sidebar.vue';
import Composer from './components/Composer.vue';
import ChatResults from './components/ChatResults.vue';
import QueuePanel from './components/QueuePanel.vue';
import ResultPanel from './components/ResultPanel.vue';
import AccountMenu from './components/AccountMenu.vue';
import { subscribeToChanges } from './api/client';
import { mediaModelBrandId, modelBrand } from './domain/model-catalog';
import { useStudioStore } from './stores/studio';

const studio = useStudioStore();
const rightOpen = ref(false);
const COMPOSER_HEIGHT_KEY = 'media-studio-composer-height-v2';
const savedComposerHeight = Number(localStorage.getItem(COMPOSER_HEIGHT_KEY));
const composerHeight = ref<number | null>(Number.isFinite(savedComposerHeight) && savedComposerHeight > 0 ? savedComposerHeight : null);
const composerResizing = ref(false);
const mobileView = ref<'chats' | 'workspace' | 'results'>('workspace');
const activeChatName = computed(() => studio.activeChatId === 'system:recent' ? 'Ранее' : studio.chats.find(chat => chat.id === studio.activeChatId)?.name || 'Новый чат');
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
    return { name: model?.name || 'Codex', provider: 'Codex', brand: modelBrand('codex') };
  }
  const model = studio.currentMediaModel;
  const provider = studio.catalog?.providers.find(item => item.id === model?.providerId)?.name || 'Kie.ai';
  const brandId = model ? mediaModelBrandId(model.id, model.name) : 'other';
  return { name: model?.name || 'Выберите модель', provider, brand: modelBrand(brandId) };
});
const startupTitle = computed(() => studio.databaseState === 'unavailable'
  ? 'Восстанавливаем соединение с базой данных…'
  : studio.databaseState === 'connecting'
    ? 'Проверяем соединение с базой данных…'
    : 'Загружаем рабочее пространство…');
let unsubscribe = () => {};
let stopComposerResize = () => {};
const composerStyle = computed(() => composerHeight.value ? { height: `${composerHeight.value}px`, maxHeight: 'none' } : undefined);

function clampComposerHeight(value: number) {
  const center = document.querySelector<HTMLElement>('.studio-center');
  const welcome = center?.querySelector<HTMLElement>('.welcome');
  const handle = center?.querySelector<HTMLElement>('.composer-resize-handle');
  const feedReserve = center?.classList.contains('has-chat-results') ? 120 : 0;
  const workspaceHeight = center?.parentElement?.getBoundingClientRect().height || center?.getBoundingClientRect().height || 0;
  const available = workspaceHeight
    ? workspaceHeight - (welcome?.offsetHeight || 0) - (handle?.offsetHeight || 0) - feedReserve - 24
    : window.innerHeight - 170;
  return Math.round(Math.max(168, Math.min(value, Math.max(168, available))));
}
function setComposerHeight(value: number) {
  composerHeight.value = clampComposerHeight(value);
  localStorage.setItem(COMPOSER_HEIGHT_KEY, String(composerHeight.value));
}
function startComposerResize(event: PointerEvent) {
  if (event.button !== 0 || window.matchMedia('(max-width: 720px)').matches) return;
  const card = document.querySelector<HTMLElement>('.composer-card');
  if (!card) return;
  event.preventDefault();
  stopComposerResize();
  const startY = event.clientY;
  const startHeight = card.getBoundingClientRect().height;
  composerResizing.value = true;
  const move = (next: PointerEvent) => { composerHeight.value = clampComposerHeight(startHeight + startY - next.clientY); };
  const finish = () => {
    if (composerHeight.value) localStorage.setItem(COMPOSER_HEIGHT_KEY, String(composerHeight.value));
    composerResizing.value = false;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', finish);
  };
  stopComposerResize = finish;
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', finish);
  window.addEventListener('pointercancel', finish);
}
function resizeComposerWithKeyboard(event: KeyboardEvent) {
  if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
  event.preventDefault();
  const current = document.querySelector<HTMLElement>('.composer-card')?.getBoundingClientRect().height || 420;
  setComposerHeight(current + (event.key === 'ArrowUp' ? 24 : -24));
}
function resetComposerHeight() {
  composerHeight.value = null;
  localStorage.removeItem(COMPOSER_HEIGHT_KEY);
}
function fitComposerHeight() {
  if (composerHeight.value) composerHeight.value = clampComposerHeight(composerHeight.value);
}

async function showHistory() {
  rightOpen.value = true;
  mobileView.value = 'results';
  await nextTick();
  document.getElementById('chat-history')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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

onMounted(async () => {
  await studio.initialize();
  await nextTick();
  fitComposerHeight();
  window.addEventListener('resize', fitComposerHeight);
  unsubscribe = subscribeToChanges(() => { void studio.refresh(); });
});

onBeforeUnmount(() => {
  unsubscribe();
  stopComposerResize();
  window.removeEventListener('resize', fitComposerHeight);
  studio.stopCodexPolling();
  studio.stopStartupPolling();
});
</script>

<template>
  <div class="studio-app" :class="[`mobile-view-${mobileView}`, { 'right-panel-open': rightOpen, 'composer-resizing': composerResizing }]">
    <Sidebar />
    <main class="studio-main">
      <header class="studio-header"><div><span class="eyebrow">ТЕКУЩИЙ ЧАТ · {{ activeChatName }}</span><h1>Генерация</h1></div><div class="header-actions"><span class="balance-badge">Аккаунт: {{ studio.accountActive.length }} активных</span><button type="button" class="results-toggle" @click="rightOpen = true">Очередь и результаты</button><a href="/legacy" class="legacy-link">Старая студия</a><AccountMenu :ready="studio.accountReady" @history="showHistory" /></div></header>
      <div v-if="!studio.accountReady" class="database-connecting" role="status" aria-live="polite"><span class="database-spinner" aria-hidden="true"></span><div><strong>{{ startupTitle }}</strong><span>{{ studio.providerReadiness === 'checking' ? 'Параллельно проверяем Kie.ai' : studio.providerReadiness === 'ready' ? 'Kie.ai проверен и готов' : studio.providerReadiness === 'error' ? 'Kie.ai требует проверки' : 'Подготавливаем сервисы' }}</span></div></div>
      <div v-if="studio.error" class="global-error" role="alert">{{ studio.error }} <button type="button" @click="studio.initialize">Повторить</button></div>
      <div class="studio-grid" :class="{ 'account-loading': !studio.accountReady }"><div class="studio-center" :class="{ 'has-chat-results': studio.visibleRecords.length }"><section class="welcome" :class="{ 'welcome-compact': studio.visibleRecords.length }" aria-label="Текущая модель"><span class="welcome-model-icon" :style="{ '--brand-accent': welcomeModel.brand.accent }"><img v-if="welcomeModel.brand.icon" :src="welcomeModel.brand.icon" alt=""><span v-else>{{ welcomeModel.brand.label.slice(0, 1) }}</span></span><h2>{{ welcomeModel.name }}</h2><p>{{ welcomeModel.provider }} · {{ modeLabels[studio.mode] }}</p><div class="welcome-suggestions" aria-label="Идеи для промпта"><button v-for="suggestion in promptSuggestions" :key="suggestion[0]" type="button" @click="usePromptSuggestion(suggestion[1])">{{ suggestion[0] }}</button></div></section><ChatResults v-if="studio.visibleRecords.length" @select="selectResult" /><button type="button" class="composer-resize-handle" aria-label="Изменить высоту формы" title="Потяните, чтобы изменить высоту. Двойной щелчок — сбросить" @pointerdown="startComposerResize" @keydown="resizeComposerWithKeyboard" @dblclick="resetComposerHeight"><span></span></button><Composer :style="composerStyle" /></div><div class="studio-right"><button type="button" class="right-close" aria-label="Закрыть результаты" @click="rightOpen = false">×</button><QueuePanel /><ResultPanel /></div></div>
    </main>
    <nav class="mobile-nav" aria-label="Разделы студии"><button type="button" :class="{ active: mobileView === 'chats' }" @click="mobileView = 'chats'">Чаты</button><button type="button" :class="{ active: mobileView === 'workspace' }" @click="mobileView = 'workspace'">Работа</button><button type="button" :class="{ active: mobileView === 'results' }" @click="mobileView = 'results'">Результаты</button></nav>
  </div>
</template>
