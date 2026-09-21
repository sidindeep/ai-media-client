<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import Sidebar from './components/Sidebar.vue';
import Composer from './components/Composer.vue';
import QueuePanel from './components/QueuePanel.vue';
import ResultPanel from './components/ResultPanel.vue';
import AccountMenu from './components/AccountMenu.vue';
import { subscribeToChanges } from './api/client';
import { mediaModelBrandId, modelBrand } from './domain/model-catalog';
import { useStudioStore } from './stores/studio';

const studio = useStudioStore();
const rightOpen = ref(false);
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

onMounted(async () => {
  await studio.initialize();
  unsubscribe = subscribeToChanges(() => { void studio.refresh(); });
});

onBeforeUnmount(() => {
  unsubscribe();
  studio.stopCodexPolling();
  studio.stopStartupPolling();
});
</script>

<template>
  <div class="studio-app" :class="[`mobile-view-${mobileView}`, { 'right-panel-open': rightOpen }]">
    <Sidebar />
    <main class="studio-main">
      <header class="studio-header"><div><span class="eyebrow">ТЕКУЩИЙ ЧАТ · {{ activeChatName }}</span><h1>Генерация</h1></div><div class="header-actions"><span class="balance-badge">Аккаунт: {{ studio.accountActive.length }} активных</span><button type="button" class="results-toggle" @click="rightOpen = true">Очередь и результаты</button><a href="/legacy" class="legacy-link">Старая студия</a><AccountMenu :ready="studio.accountReady" @history="showHistory" /></div></header>
      <div v-if="!studio.accountReady" class="database-connecting" role="status" aria-live="polite"><span class="database-spinner" aria-hidden="true"></span><div><strong>{{ startupTitle }}</strong><span>{{ studio.providerReadiness === 'checking' ? 'Параллельно проверяем Kie.ai' : studio.providerReadiness === 'ready' ? 'Kie.ai проверен и готов' : studio.providerReadiness === 'error' ? 'Kie.ai требует проверки' : 'Подготавливаем сервисы' }}</span></div></div>
      <div v-if="studio.error" class="global-error" role="alert">{{ studio.error }} <button type="button" @click="studio.initialize">Повторить</button></div>
      <div class="studio-grid" :class="{ 'account-loading': !studio.accountReady }"><div class="studio-center"><section class="welcome" aria-label="Текущая модель"><span class="welcome-model-icon" :style="{ '--brand-accent': welcomeModel.brand.accent }"><img v-if="welcomeModel.brand.icon" :src="welcomeModel.brand.icon" alt=""><span v-else>{{ welcomeModel.brand.label.slice(0, 1) }}</span></span><h2>{{ welcomeModel.name }}</h2><p>{{ welcomeModel.provider }} · {{ modeLabels[studio.mode] }}</p><div class="welcome-suggestions" aria-label="Идеи для промпта"><button v-for="suggestion in promptSuggestions" :key="suggestion[0]" type="button" @click="usePromptSuggestion(suggestion[1])">{{ suggestion[0] }}</button></div></section><Composer /></div><div class="studio-right"><button type="button" class="right-close" aria-label="Закрыть результаты" @click="rightOpen = false">×</button><QueuePanel /><ResultPanel /></div></div>
    </main>
    <nav class="mobile-nav" aria-label="Разделы студии"><button type="button" :class="{ active: mobileView === 'chats' }" @click="mobileView = 'chats'">Чаты</button><button type="button" :class="{ active: mobileView === 'workspace' }" @click="mobileView = 'workspace'">Работа</button><button type="button" :class="{ active: mobileView === 'results' }" @click="mobileView = 'results'">Результаты</button></nav>
  </div>
</template>
