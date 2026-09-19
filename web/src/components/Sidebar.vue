<script setup lang="ts">
import { computed, ref } from 'vue';
import { useStudioStore } from '../stores/studio';

const studio = useStudioStore();
const activeTab = ref<'chats' | 'projects'>('chats');
const search = ref('');
const projects = ref([{ id: 'default', name: 'Мои генерации', count: 0 }]);
const chats = computed(() => [{ id: 'recent', name: 'Ранее', meta: `${studio.history.length} генераций` }]);
const filteredChats = computed(() => chats.value.filter(chat => chat.name.toLowerCase().includes(search.value.toLowerCase())));

function addProject() {
  const name = window.prompt('Название проекта');
  if (name?.trim()) projects.value.push({ id: crypto.randomUUID(), name: name.trim(), count: 0 });
}
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar-brand"><span class="brand-mark">ИИ</span><div><strong>Медиастудия</strong><small>WEB · STUDIO</small></div></div>
    <div class="sidebar-toolbar"><label class="search"><span aria-hidden="true">⌕</span><input v-model="search" type="search" placeholder="Поиск" aria-label="Поиск чатов и проектов" /></label><button class="icon-button" type="button" aria-label="Новый чат" @click="studio.prompt = ''">＋</button></div>
    <div class="sidebar-tabs" role="tablist">
      <button type="button" :class="{ active: activeTab === 'chats' }" @click="activeTab = 'chats'">Чаты</button>
      <button type="button" :class="{ active: activeTab === 'projects' }" @click="activeTab = 'projects'">Проекты</button>
    </div>
    <div v-if="activeTab === 'chats'" class="sidebar-list">
      <div class="list-heading"><span>Ранее</span><button type="button" class="subtle-button">•••</button></div>
      <button v-for="chat in filteredChats" :key="chat.id" type="button" class="list-item selected" @click="studio.select(studio.active[0]?.id || '')"><span class="list-icon">✦</span><span><strong>{{ chat.name }}</strong><small>{{ chat.meta }}</small></span></button>
      <p v-if="!filteredChats.length" class="empty-copy">Ничего не найдено</p>
    </div>
    <div v-else class="sidebar-list">
      <div class="list-heading"><span>Рабочие пространства</span><button type="button" class="subtle-button" @click="addProject">＋</button></div>
      <button v-for="project in projects" :key="project.id" type="button" class="list-item"><span class="project-icon">◈</span><span><strong>{{ project.name }}</strong><small>{{ project.count || studio.history.length }} генераций</small></span></button>
    </div>
    <div class="sidebar-bottom"><span class="connection-dot" :class="{ ready: !studio.error }"></span><span>{{ studio.error ? 'Нет связи с сервисом' : 'Сервис подключён' }}</span></div>
  </aside>
</template>
