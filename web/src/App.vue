<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue';
import Sidebar from './components/Sidebar.vue';
import Composer from './components/Composer.vue';
import QueuePanel from './components/QueuePanel.vue';
import ResultPanel from './components/ResultPanel.vue';
import { subscribeToChanges } from './api/client';
import { useStudioStore } from './stores/studio';

const studio = useStudioStore();
let unsubscribe = () => {};

onMounted(async () => {
  await studio.initialize();
  unsubscribe = subscribeToChanges(() => { void studio.refresh(); });
});

onBeforeUnmount(() => unsubscribe());
</script>

<template>
  <div class="studio-app">
    <Sidebar />
    <main class="studio-main">
      <header class="studio-header"><div><span class="eyebrow">AI MEDIA CLIENT</span><h1>Генерация</h1></div><div class="header-actions"><span class="balance-badge">Баланс · синхронизируется</span><a href="/" class="legacy-link">Старая студия</a></div></header>
      <div v-if="studio.error" class="global-error" role="alert">{{ studio.error }} <button type="button" @click="studio.initialize">Повторить</button></div>
      <div v-if="studio.loading" class="loading-state">Загружаем каталог и историю…</div>
      <template v-else>
        <div class="studio-grid"><div class="studio-center"><div class="welcome"><span class="eyebrow">НОВАЯ ГЕНЕРАЦИЯ</span><h2>Соберите идею в один запрос</h2><p>Выберите направление, опишите задачу и следите за результатом справа.</p></div><Composer /></div><div class="studio-right"><QueuePanel /><ResultPanel /></div></div>
        <section class="recent-section"><div class="section-heading"><div><span class="eyebrow">ИСТОРИЯ</span><h2>Последние генерации</h2></div><button type="button" class="text-button" @click="studio.refresh">Обновить</button></div><div class="recent-grid"><button v-for="item in studio.completed.slice(0, 6)" :key="item.id" type="button" class="recent-item" @click="studio.select(item.id)"><span class="recent-state">{{ item.state === 'success' ? '●' : '○' }}</span><span><strong>{{ item.modelName || item.modelId || item.providerName || 'Генерация' }}</strong><small>{{ item.input?.prompt || item.error || 'Без промпта' }}</small></span></button><p v-if="!studio.completed.length" class="empty-state">Завершённые генерации появятся здесь.</p></div></section>
      </template>
    </main>
  </div>
</template>
