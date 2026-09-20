<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import Sidebar from './components/Sidebar.vue';
import Composer from './components/Composer.vue';
import QueuePanel from './components/QueuePanel.vue';
import ResultPanel from './components/ResultPanel.vue';
import AccountMenu from './components/AccountMenu.vue';
import { subscribeToChanges } from './api/client';
import { useStudioStore } from './stores/studio';

const studio = useStudioStore();
const rightOpen = ref(false);
const mobileView = ref<'chats' | 'workspace' | 'results'>('workspace');
const activeChatName = computed(() => studio.activeChatId === 'system:recent' ? 'Ранее' : studio.chats.find(chat => chat.id === studio.activeChatId)?.name || 'Новый чат');
let unsubscribe = () => {};

async function showHistory() {
  rightOpen.value = true;
  mobileView.value = 'results';
  await nextTick();
  document.getElementById('chat-history')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
      <div v-if="!studio.accountReady" class="database-connecting" role="status" aria-live="polite"><span class="database-spinner" aria-hidden="true"></span><div><strong>Подключаемся к базе данных…</strong><span>{{ studio.providerReadiness === 'checking' ? 'Параллельно проверяем Kie.ai' : studio.providerReadiness === 'ready' ? 'Kie.ai проверен и готов' : studio.providerReadiness === 'error' ? 'Kie.ai требует проверки' : 'Подготавливаем сервисы' }}</span></div></div>
      <div v-if="studio.error" class="global-error" role="alert">{{ studio.error }} <button type="button" @click="studio.initialize">Повторить</button></div>
      <div class="studio-grid" :class="{ 'account-loading': !studio.accountReady }"><div class="studio-center"><div class="welcome"><span class="eyebrow">НОВАЯ ГЕНЕРАЦИЯ</span><h2>{{ activeChatName }}</h2><p>Выберите формат, добавьте исходники и запустите задачу в контексте этого чата.</p></div><Composer /></div><div class="studio-right"><button type="button" class="right-close" aria-label="Закрыть результаты" @click="rightOpen = false">×</button><QueuePanel /><ResultPanel /></div></div>
    </main>
    <nav class="mobile-nav" aria-label="Разделы студии"><button type="button" :class="{ active: mobileView === 'chats' }" @click="mobileView = 'chats'">Чаты</button><button type="button" :class="{ active: mobileView === 'workspace' }" @click="mobileView = 'workspace'">Работа</button><button type="button" :class="{ active: mobileView === 'results' }" @click="mobileView = 'results'">Результаты</button></nav>
  </div>
</template>
