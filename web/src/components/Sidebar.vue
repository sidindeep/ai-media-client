<script setup lang="ts">
import { computed, ref } from 'vue';
import { useStudioStore } from '../stores/studio';
import type { Chat, Project } from '../types';

const studio = useStudioStore();
const activeTab = ref<'chats' | 'projects'>('chats');
const search = ref('');
const collapsed = ref(false);
const menuId = ref<string | null>(null);

const filteredProjects = computed(() => studio.projects.filter(project => project.name.toLowerCase().includes(search.value.trim().toLowerCase())));
const filteredChats = computed(() => {
  const term = search.value.trim().toLowerCase();
  return studio.chats.filter(chat => chat.name.toLowerCase().includes(term) || (studio.projects.find(project => project.id === chat.projectId)?.name || '').toLowerCase().includes(term));
});
const groupedChats = computed(() => {
  const today: Chat[] = [], earlier: Chat[] = [];
  const day = new Date().toDateString();
  for (const chat of filteredChats.value) ((chat.updatedAt && new Date(chat.updatedAt).toDateString() === day) ? today : earlier).push(chat);
  return { today, earlier };
});

function askName(label: string, current = '') {
  const value = window.prompt(label, current);
  return value?.trim() || '';
}
async function addProject() { const name = askName('Название проекта'); if (name) await studio.createProject(name); }
async function addChat(projectId: string | null = null) { const name = askName('Название чата', 'Новый чат'); if (name) await studio.createChat(name, projectId); }
async function renameProject(project: Project) { const name = askName('Новое название проекта', project.name); if (name && name !== project.name) await studio.renameProject(project.id, name); menuId.value = null; }
async function renameChat(chat: Chat) { const name = askName('Новое название чата', chat.name); if (name && name !== chat.name) await studio.renameChat(chat.id, name); menuId.value = null; }
async function archiveProject(project: Project) { if (window.confirm('Архивировать проект «' + project.name + '»?')) await studio.archiveProject(project.id); menuId.value = null; }
async function archiveChat(chat: Chat) { if (window.confirm('Архивировать чат «' + chat.name + '»?')) await studio.archiveChat(chat.id); menuId.value = null; }
async function moveChat(chat: Chat) {
  const options = ['Без проекта', ...studio.projects.map(project => project.name)];
  const choice = window.prompt('Перенести чат. Варианты: ' + options.join(', '), chat.projectId ? studio.projects.find(project => project.id === chat.projectId)?.name : 'Без проекта');
  if (choice === null) return;
  const project = studio.projects.find(item => item.name.toLowerCase() === choice.trim().toLowerCase());
  await studio.moveChat(chat.id, project?.id || null); menuId.value = null;
}
function selectChat(chat: Chat) { studio.selectChat(chat.id); menuId.value = null; }
</script>

<template>
  <aside class="sidebar" :class="{ collapsed }">
    <div class="sidebar-brand"><span class="brand-mark">ИИ</span><div><strong>Медиастудия</strong><small>WEB · STUDIO</small></div><button type="button" class="collapse-button" aria-label="Свернуть панель" @click="collapsed = !collapsed">‹</button></div>
    <template v-if="!collapsed">
      <div class="sidebar-toolbar"><label class="search"><span aria-hidden="true">⌕</span><input v-model="search" type="search" placeholder="Поиск" aria-label="Поиск чатов и проектов" /></label><button class="icon-button" type="button" aria-label="Новый чат" @click="() => addChat()">＋</button></div>
      <div class="sidebar-tabs" role="tablist"><button type="button" :class="{ active: activeTab === 'chats' }" @click="activeTab = 'chats'">Чаты</button><button type="button" :class="{ active: activeTab === 'projects' }" @click="activeTab = 'projects'">Проекты</button></div>
      <div v-if="activeTab === 'chats'" class="sidebar-list">
        <div class="list-heading"><span>Ранее</span><button type="button" class="subtle-button" aria-label="Новый чат" @click="() => addChat()">＋</button></div>
        <button type="button" class="list-item" :class="{ selected: studio.activeChatId === 'system:recent' }" @click="selectChat(studio.systemChat)"><span class="list-icon">✦</span><span><strong>Ранее</strong><small>{{ studio.history.length }} генераций</small></span></button>
        <div v-if="groupedChats.today.length" class="group-label">Сегодня</div>
        <div v-for="chat in groupedChats.today" :key="chat.id" class="sidebar-entry"><button type="button" class="list-item" :class="{ selected: studio.activeChatId === chat.id }" @click="selectChat(chat)"><span class="list-icon">◌</span><span><strong>{{ chat.name }}</strong><small>{{ studio.projects.find(project => project.id === chat.projectId)?.name || 'Без проекта' }} · {{ chat.materialCount }} материалов</small></span></button><button type="button" class="entry-menu" aria-label="Действия чата" @click.stop="menuId = menuId === chat.id ? null : chat.id">•••</button><div v-if="menuId === chat.id" class="entry-actions"><button type="button" @click="renameChat(chat)">Переименовать</button><button type="button" @click="moveChat(chat)">Перенести</button><button type="button" @click="archiveChat(chat)">Архивировать</button></div></div>
        <div v-if="groupedChats.earlier.length" class="group-label">Ранее</div>
        <div v-for="chat in groupedChats.earlier" :key="chat.id" class="sidebar-entry"><button type="button" class="list-item" :class="{ selected: studio.activeChatId === chat.id }" @click="selectChat(chat)"><span class="list-icon">◌</span><span><strong>{{ chat.name }}</strong><small>{{ studio.projects.find(project => project.id === chat.projectId)?.name || 'Без проекта' }} · {{ chat.materialCount }} материалов</small></span></button><button type="button" class="entry-menu" aria-label="Действия чата" @click.stop="menuId = menuId === chat.id ? null : chat.id">•••</button><div v-if="menuId === chat.id" class="entry-actions"><button type="button" @click="renameChat(chat)">Переименовать</button><button type="button" @click="moveChat(chat)">Перенести</button><button type="button" @click="archiveChat(chat)">Архивировать</button></div></div>
        <p v-if="!filteredChats.length" class="empty-copy">Чатов пока нет</p>
      </div>
      <div v-else class="sidebar-list"><div class="list-heading"><span>Рабочие пространства</span><button type="button" class="subtle-button" aria-label="Новый проект" @click="addProject">＋</button></div><div v-for="project in filteredProjects" :key="project.id" class="sidebar-entry"><button type="button" class="list-item" @click="activeTab = 'chats'; search = ''; studio.selectProject(project.id)"><span class="project-icon">◈</span><span><strong>{{ project.name }}</strong><small>{{ project.chatCount }} чатов · {{ project.materialCount }} материалов</small></span></button><button type="button" class="entry-menu" aria-label="Действия проекта" @click.stop="menuId = menuId === project.id ? null : project.id">•••</button><div v-if="menuId === project.id" class="entry-actions"><button type="button" @click="renameProject(project)">Переименовать</button><button type="button" @click="addChat(project.id); menuId = null">Новый чат</button><button type="button" @click="archiveProject(project)">Архивировать</button></div></div><p v-if="!filteredProjects.length" class="empty-copy">Проектов пока нет</p></div>
    </template>
    <div class="sidebar-bottom"><span class="connection-dot" :class="{ ready: !studio.error }"></span><span>{{ studio.error ? 'Нет связи с сервисом' : 'Сервис подключён' }}</span></div>
  </aside>
</template>
