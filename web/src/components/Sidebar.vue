<script setup lang="ts">
import { computed, ref } from 'vue';
import { useStudioStore } from '../stores/studio';
import type { Chat, Project } from '../types';

const props = defineProps<{ activeSection: 'workspace' | 'history' }>();
const emit = defineEmits<{ workspace: []; history: [] }>();
const studio = useStudioStore();
const activeTab = ref<'chats' | 'projects'>('chats');
const search = ref('');
const collapsed = ref(false);
const menuId = ref<string | null>(null);
const selectedProjectId = ref<string | null>(null);
const providers = [
  { id: 'codex', label: 'Codex CLI', detail: 'GPT · текст и изображения', icon: 'C' },
  { id: 'media', label: 'Kie.ai', detail: 'Изображения, видео и аудио', icon: 'K' },
] as const;
const mediaProviderName = computed(() => studio.catalog?.providers.find(provider => provider.id === 'media')?.name || 'Kie.ai');
const providerItems = computed(() => providers.map(item => item.id === 'media' ? { ...item, label: mediaProviderName.value } : item));
const activeProvider = computed(() => providerItems.value.find(item => item.id === studio.provider) || providerItems.value[0]);
const debugToolsVisible = computed(() => studio.release?.channel === 'debug');
const formatStartupDuration = (milliseconds: number | null) => {
  if (milliseconds === null) return '—';
  if (milliseconds < 1000) return `${milliseconds} мс`;
  return `${new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(milliseconds / 1000)} с`;
};
const startupTimingLabel = computed(() => studio.accountReady && studio.readyElapsedMs !== null
  ? `Подключение: ${formatStartupDuration(studio.connectionElapsedMs)} · данные: ${formatStartupDuration(studio.dataLoadElapsedMs)} · готово: ${formatStartupDuration(studio.readyElapsedMs)}`
  : '');

const filteredProjects = computed(() => {
  const term = search.value.trim().toLowerCase();
  return studio.projects.filter(project => !term
    || project.name.toLowerCase().includes(term)
    || studio.chats.some(chat => chat.projectId === project.id && chat.name.toLowerCase().includes(term)));
});
const scopedChats = computed(() => studio.chats.filter(chat => !chat.projectId));
const filteredChats = computed(() => {
  const term = search.value.trim().toLowerCase();
  return scopedChats.value.filter(chat => chat.name.toLowerCase().includes(term));
});
const groupedChats = computed(() => {
  const today: Chat[] = [], earlier: Chat[] = [];
  const day = new Date().toDateString();
  for (const chat of filteredChats.value) ((chat.updatedAt && new Date(chat.updatedAt).toDateString() === day) ? today : earlier).push(chat);
  return { today, earlier };
});
const releaseLabel = computed(() => {
  const release = studio.release;
  if (!release) return 'Версия недоступна';
  const builtAt = release.builtAt ? new Date(release.builtAt) : null;
  const date = builtAt && !Number.isNaN(builtAt.getTime())
    ? new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(builtAt).replace(',', '')
    : null;
  return `${release.channel === 'debug' ? 'DEBUG · ' : ''}Версия ${release.version}${date ? ` · ${date}` : ''} · сборка ${release.build}`;
});

function askName(label: string, current = '') {
  const value = window.prompt(label, current);
  return value?.trim() || '';
}
async function addProject() { const name = askName('Название проекта'); if (name) await studio.createProject(name); }
async function addChat(projectId: string | null = null) {
  const name = askName('Название чата', 'Новый чат');
  if (!name) return;
  await studio.createChat(name, projectId);
  if (projectId) selectedProjectId.value = projectId;
}
async function renameProject(project: Project) { const name = askName('Новое название проекта', project.name); if (name && name !== project.name) await studio.renameProject(project.id, name); menuId.value = null; }
async function renameChat(chat: Chat) { const name = askName('Новое название чата', chat.name); if (name && name !== chat.name) await studio.renameChat(chat.id, name); menuId.value = null; }
async function archiveProject(project: Project) { if (window.confirm('Архивировать проект «' + project.name + '»?')) { await studio.archiveProject(project.id); if (selectedProjectId.value === project.id) selectedProjectId.value = null; } menuId.value = null; }
async function archiveChat(chat: Chat) { if (window.confirm('Архивировать чат «' + chat.name + '»?')) await studio.archiveChat(chat.id); menuId.value = null; }
async function moveChat(chat: Chat) {
  const options = ['Без проекта', ...studio.projects.map(project => project.name)];
  const choice = window.prompt('Перенести чат. Варианты: ' + options.join(', '), chat.projectId ? studio.projects.find(project => project.id === chat.projectId)?.name : 'Без проекта');
  if (choice === null) return;
  const project = studio.projects.find(item => item.name.toLowerCase() === choice.trim().toLowerCase());
  await studio.moveChat(chat.id, project?.id || null); menuId.value = null;
}
function selectChat(chat: Chat) { studio.selectChat(chat.id); menuId.value = null; emit('workspace'); }
function selectTab(tab: 'chats' | 'projects') {
  activeTab.value = tab; search.value = ''; menuId.value = null;
  if (tab === 'chats') { selectedProjectId.value = null; studio.selectStandalone(); emit('workspace'); }
}
function openProject(project: Project) {
  selectedProjectId.value = selectedProjectId.value === project.id ? null : project.id;
  menuId.value = null;
}
function projectChats(project: Project) {
  const term = search.value.trim().toLowerCase();
  const projectMatches = project.name.toLowerCase().includes(term);
  return studio.chats.filter(chat => chat.projectId === project.id && (!term || projectMatches || chat.name.toLowerCase().includes(term)));
}
async function primaryAdd() {
  if (activeTab.value === 'chats') return addChat();
  return addProject();
}
const primaryActionLabel = computed(() => activeTab.value === 'chats' ? 'Новый чат' : 'Новый проект');
function selectProvider(value: typeof providers[number]['id'], event: Event) {
  studio.setProvider(value);
  const details = (event.currentTarget as HTMLElement).closest('details') as HTMLDetailsElement | null;
  if (details) details.open = false;
}
function diagnoseKie(event: Event) {
  studio.setProvider('media');
  studio.requestProviderDiagnostics();
  const details = (event.currentTarget as HTMLElement).closest('details') as HTMLDetailsElement | null;
  if (details) details.open = false;
}
</script>

<template>
  <aside class="sidebar" :class="{ collapsed }">
    <div class="sidebar-brand"><a class="brand-mark" href="/" aria-label="На главную" title="На главную">ИИ</a><div><strong>Медиастудия</strong><small>WEB · STUDIO</small><span class="sidebar-version">{{ releaseLabel }}</span></div><button type="button" class="collapse-button" aria-label="Свернуть панель" @click="collapsed = !collapsed">‹</button></div>
    <nav class="sidebar-primary-nav" aria-label="Основная навигация">
      <a class="sidebar-home-link" href="/" aria-label="Главная" title="Главная">
        <span class="sidebar-home-icon" aria-hidden="true"><svg viewBox="0 0 24 24" role="presentation"><path d="M3.75 10.5 12 3.75l8.25 6.75v8.25a1.5 1.5 0 0 1-1.5 1.5H5.25a1.5 1.5 0 0 1-1.5-1.5V10.5Z" /><path d="M9 20.25v-6h6v6" /></svg></span>
        <span>Главная</span>
      </a>
      <button type="button" class="sidebar-home-link sidebar-history-link" :class="{ active: props.activeSection === 'history' }" aria-label="История" title="История" @click="emit('history')">
        <span class="sidebar-home-icon" aria-hidden="true"><svg viewBox="0 0 24 24" role="presentation"><circle cx="12" cy="12" r="8.25" /><path d="M12 7.5v4.75l3.25 2" /></svg></span>
        <span>История</span>
      </button>
    </nav>
    <template v-if="!collapsed">
      <div class="sidebar-toolbar"><label class="search"><span aria-hidden="true">⌕</span><input v-model="search" type="search" placeholder="Поиск" aria-label="Поиск чатов и проектов" /></label><button class="icon-button" type="button" :aria-label="primaryActionLabel" @click="primaryAdd">＋</button></div>
      <div class="sidebar-tabs" role="tablist"><button type="button" :class="{ active: activeTab === 'chats' }" @click="selectTab('chats')">Чаты</button><button type="button" :class="{ active: activeTab === 'projects' }" @click="selectTab('projects')">Проекты</button></div>
      <div v-if="activeTab === 'chats'" class="sidebar-list">
        <div class="list-heading"><span>Отдельные чаты</span><button type="button" class="subtle-button" aria-label="Новый чат" @click="() => addChat()">＋</button></div>
        <button type="button" class="list-item" :class="{ selected: studio.activeChatId === 'system:recent' }" @click="selectChat(studio.systemChat)"><span class="list-icon">✦</span><span><strong>Ранее</strong><small>{{ studio.history.length }} генераций</small></span></button>
        <div v-if="groupedChats.today.length" class="group-label">Сегодня</div>
        <div v-for="chat in groupedChats.today" :key="chat.id" class="sidebar-entry"><button type="button" class="list-item" :class="{ selected: studio.activeChatId === chat.id }" @click="selectChat(chat)"><span class="list-icon">◌</span><span><strong>{{ chat.name }}</strong><small>{{ chat.materialCount }} материалов</small></span></button><button type="button" class="entry-menu" aria-label="Действия чата" @click.stop="menuId = menuId === chat.id ? null : chat.id">•••</button><div v-if="menuId === chat.id" class="entry-actions"><button type="button" @click="renameChat(chat)">Переименовать</button><button type="button" @click="moveChat(chat)">Перенести</button><button type="button" @click="archiveChat(chat)">Архивировать</button></div></div>
        <div v-if="groupedChats.earlier.length" class="group-label">Ранее</div>
        <div v-for="chat in groupedChats.earlier" :key="chat.id" class="sidebar-entry"><button type="button" class="list-item" :class="{ selected: studio.activeChatId === chat.id }" @click="selectChat(chat)"><span class="list-icon">◌</span><span><strong>{{ chat.name }}</strong><small>{{ chat.materialCount }} материалов</small></span></button><button type="button" class="entry-menu" aria-label="Действия чата" @click.stop="menuId = menuId === chat.id ? null : chat.id">•••</button><div v-if="menuId === chat.id" class="entry-actions"><button type="button" @click="renameChat(chat)">Переименовать</button><button type="button" @click="moveChat(chat)">Перенести</button><button type="button" @click="archiveChat(chat)">Архивировать</button></div></div>
        <p v-if="!filteredChats.length" class="empty-copy">Отдельных чатов пока нет</p>
      </div>
      <div v-else class="sidebar-list project-list-view">
        <div class="list-heading"><span>Рабочие пространства</span><button type="button" class="subtle-button" aria-label="Новый проект" @click="addProject">＋</button></div>
        <div v-for="project in filteredProjects" :key="project.id" class="project-tree">
          <div class="sidebar-entry"><button type="button" class="list-item project-toggle" :class="{ expanded: selectedProjectId === project.id }" :aria-expanded="selectedProjectId === project.id" @click="openProject(project)"><span class="project-icon">◈</span><span><strong>{{ project.name }}</strong><small>{{ project.chatCount }} чатов · {{ project.materialCount }} материалов</small></span><span class="project-chevron" aria-hidden="true">›</span></button><button type="button" class="entry-menu" aria-label="Действия проекта" @click.stop="menuId = menuId === project.id ? null : project.id">•••</button><div v-if="menuId === project.id" class="entry-actions"><button type="button" @click="renameProject(project)">Переименовать</button><button type="button" @click="addChat(project.id); menuId = null">Новый чат</button><button type="button" @click="archiveProject(project)">Архивировать</button></div></div>
          <div v-if="selectedProjectId === project.id" class="project-children">
            <div v-for="chat in projectChats(project)" :key="chat.id" class="sidebar-entry project-child"><button type="button" class="list-item" :class="{ selected: studio.activeChatId === chat.id }" @click="selectChat(chat)"><span><strong>{{ chat.name }}</strong><small>{{ chat.materialCount }} материалов</small></span></button><button type="button" class="entry-menu" aria-label="Действия чата" @click.stop="menuId = menuId === chat.id ? null : chat.id">•••</button><div v-if="menuId === chat.id" class="entry-actions"><button type="button" @click="renameChat(chat)">Переименовать</button><button type="button" @click="moveChat(chat)">Перенести</button><button type="button" @click="archiveChat(chat)">Архивировать</button></div></div>
            <p v-if="!projectChats(project).length" class="empty-copy project-empty">В проекте пока нет чатов</p>
          </div>
        </div>
        <p v-if="!filteredProjects.length" class="empty-copy">Проектов пока нет</p>
      </div>
      <details v-if="debugToolsVisible" class="sidebar-provider-menu">
        <summary><span class="sidebar-provider-icon" aria-hidden="true">{{ activeProvider.icon }}</span><span><small>Поставщик</small><strong>{{ activeProvider.label }}</strong></span><span class="sidebar-provider-chevron" aria-hidden="true">⌃</span></summary>
        <div class="sidebar-provider-options" role="menu">
          <div v-for="item in providerItems" :key="item.id" class="sidebar-provider-row"><button type="button" class="sidebar-provider-option" :class="{ active: studio.provider === item.id }" :data-provider="item.id" role="menuitem" @click="selectProvider(item.id, $event)"><span class="provider-option-icon" aria-hidden="true">{{ item.icon }}</span><span><strong>{{ item.label }}</strong><small>{{ item.detail }}</small></span><span v-if="studio.provider === item.id" aria-hidden="true">✓</span></button><button v-if="item.id === 'media'" type="button" class="sidebar-provider-check" @click="diagnoseKie">Проверить Kie</button></div>
        </div>
      </details>
    </template>
    <div class="sidebar-bottom"><span class="connection-dot" :class="{ ready: studio.accountReady && !studio.error }"></span><div class="sidebar-status-copy"><span>{{ studio.error ? 'Нет связи с сервисом' : studio.accountReady ? 'Сервис подключён' : 'Подключаемся к БД' }}</span><small v-if="startupTimingLabel" class="sidebar-startup-timing">{{ startupTimingLabel }}</small></div></div>
  </aside>
</template>
