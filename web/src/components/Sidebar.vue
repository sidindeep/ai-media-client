<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useStudioStore } from '../stores/studio';
import { getProviderStatus } from '../api/client';
import type { ProviderStatus } from '../api/client';
import { useI18n } from '../i18n';
import type { Chat, Project } from '../types';

const props = defineProps<{ activeSection: 'landing' | 'home' | 'workspace' | 'history' | 'spending' }>();
const emit = defineEmits<{ landing: []; home: []; workspace: []; history: []; spending: [] }>();
const studio = useStudioStore();
const { formatDate, formatNumber, t, tp } = useI18n();
const activeTab = ref<'chats' | 'projects'>('chats');
const search = ref('');
const collapsed = ref(false);
const menuId = ref<string | null>(null);
const menuPosition = ref({ top: '0px', left: '0px' });
const selectedProjectId = ref<string | null>(null);
type ProviderId = 'codex' | 'media' | 'routerai';
type ProviderItem = { id: ProviderId; accountId?: 'primary' | 'secondary'; label: string; detail: string; icon: string; configured?: boolean };
const providerItems = computed<ProviderItem[]>(() => (studio.isAdmin ? [
  { id: 'codex' as const, label: 'Codex CLI', detail: `GPT · ${t('sidebar.textImages').toLocaleLowerCase()}`, icon: 'C' },
  { id: 'routerai' as const, label: 'RouterAI', detail: t('sidebar.mediaAll'), icon: 'R', configured: Boolean(studio.routerAiCatalog?.models.length) },
  ...(['primary', 'secondary'] as const).map((accountId, index) => {
    const account = studio.catalog?.kieAccounts?.find(item => item.id === accountId);
    return { id: 'media' as const, accountId, label: account?.name || `Kie.ai · ${index + 1}`, detail: account?.configured ? t('sidebar.mediaAll') : t('sidebar.kieNotConfigured'), icon: 'K', configured: Boolean(account?.configured) };
  }),
] : [
  { id: 'codex' as const, label: t('provider.aiModels'), detail: t('sidebar.textImages'), icon: '✦' },
  { id: 'routerai' as const, label: 'RouterAI', detail: t('sidebar.textImages'), icon: 'R', configured: Boolean(studio.routerAiCatalog?.models.length) },
  { id: 'media' as const, label: t('provider.mediaModels'), detail: t('sidebar.mediaAll'), icon: '◇' },
])
  .filter(item => (studio.fullModelAccess || item.id === 'codex') && (item.id !== 'routerai' || item.configured))
  .map(item => !studio.fullModelAccess && item.id === 'codex' ? { ...item, label: t('sidebar.gptModels'), detail: t('sidebar.starterAccess') } : item));
const isActiveProvider = (item: ProviderItem) => item.id === studio.provider && (!item.accountId || item.accountId === studio.kieAccountId);
const activeProvider = computed(() => providerItems.value.find(isActiveProvider) || providerItems.value[0]);
const providerStatuses = ref<Record<string, ProviderStatus | null>>({});
const providerErrors = ref<Record<string, string>>({});
const loadingStatuses = new Set<string>();
const statusDialogOpen = ref(false);
const statusDialogProvider = ref<ProviderItem | null>(null);
const statusKey = (item: ProviderItem) => item.accountId || item.id;
const statusFor = (item: ProviderItem) => providerStatuses.value[statusKey(item)];
function statusLabel(item: ProviderItem) {
  const status = statusFor(item);
  if (!status) return providerErrors.value[statusKey(item)] ? t('sidebar.balanceUnavailable') : '';
  if (status.balance?.unit === 'credits') return t('sidebar.remainingCredits', { count: formatNumber(status.balance.amount) });
  if (status.balance?.unit === 'rub') return t('sidebar.remainingRubles', { count: formatNumber(status.balance.amount) });
  const remaining = status.windows.map(window => window.remainingPercent);
  return remaining.length ? t('sidebar.remainingLimit', { count: formatNumber(Math.min(...remaining), { maximumFractionDigits: 1 }) }) : t('sidebar.balanceUnavailable');
}
async function loadProviderStatus(item: ProviderItem) {
  if (!studio.isAdmin || loadingStatuses.has(statusKey(item)) || item.configured === false) return;
  const key = statusKey(item);
  loadingStatuses.add(key);
  delete providerErrors.value[key];
  try { providerStatuses.value[key] = await getProviderStatus(item.id, item.accountId); }
  catch (error) { providerStatuses.value[key] = null; providerErrors.value[key] = error instanceof Error ? error.message : t('sidebar.balanceUnavailable'); }
  finally { loadingStatuses.delete(key); }
}
watch(() => [studio.accountReady, studio.provider, studio.kieAccountId, studio.isAdmin] as const, () => {
  if (studio.accountReady && studio.isAdmin && activeProvider.value) void loadProviderStatus(activeProvider.value);
}, { immediate: true });
function loadMenuStatuses(event: Event) {
  if ((event.currentTarget as HTMLDetailsElement).open) providerItems.value.forEach(item => void loadProviderStatus(item));
}
const formatStartupDuration = (milliseconds: number | null) => {
  if (milliseconds === null) return '—';
  if (milliseconds < 1000) return t('common.milliseconds', { count: milliseconds });
  return t('common.seconds', { count: formatNumber(milliseconds / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) });
};
const startupTimingLabel = computed(() => studio.accountReady && studio.readyElapsedMs !== null
  ? t('sidebar.startupTiming', { connection: formatStartupDuration(studio.connectionElapsedMs), data: formatStartupDuration(studio.dataLoadElapsedMs), ready: formatStartupDuration(studio.readyElapsedMs) })
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
  if (!release) return t('sidebar.versionUnavailable');
  const builtAt = release.builtAt ? new Date(release.builtAt) : null;
  const date = builtAt && !Number.isNaN(builtAt.getTime())
    ? formatDate(builtAt, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).replace(',', '')
    : null;
  return `${release.channel === 'debug' ? 'DEBUG · ' : ''}${t('landing.version', { version: release.version, date: date ? ` · ${date}` : '', build: release.commit?.slice(0, 12) || '—' })}`;
});

function askName(label: string, current = '') {
  const value = window.prompt(label, current);
  return value?.trim() || '';
}
async function addProject() { const name = askName(t('sidebar.projectName')); if (name) await studio.createProject(name); }
async function addChat(projectId: string | null = null) {
  const name = askName(t('sidebar.chatName'), t('navigation.newChat'));
  if (!name) return;
  await studio.createChat(name, projectId);
  if (projectId) selectedProjectId.value = projectId;
}
async function renameProject(project: Project) { const name = askName(t('sidebar.newProjectName'), project.name); if (name && name !== project.name) await studio.renameProject(project.id, name); menuId.value = null; }
async function renameChat(chat: Chat) { const name = askName(t('sidebar.newChatName'), chat.name); if (name && name !== chat.name) await studio.renameChat(chat.id, name); menuId.value = null; }
async function archiveProject(project: Project) { if (window.confirm(t('sidebar.archiveProject', { name: project.name }))) { await studio.archiveProject(project.id); if (selectedProjectId.value === project.id) selectedProjectId.value = null; } menuId.value = null; }
async function archiveChat(chat: Chat) { if (window.confirm(t('sidebar.archiveChat', { name: chat.name }))) await studio.archiveChat(chat.id); menuId.value = null; }
async function moveChat(chat: Chat) {
  const options = [t('sidebar.noProject'), ...studio.projects.map(project => project.name)];
  const choice = window.prompt(t('sidebar.moveChat', { options: options.join(', ') }), chat.projectId ? studio.projects.find(project => project.id === chat.projectId)?.name : t('sidebar.noProject'));
  if (choice === null) return;
  const project = studio.projects.find(item => item.name.toLowerCase() === choice.trim().toLowerCase());
  await studio.moveChat(chat.id, project?.id || null); menuId.value = null;
}
function selectChat(chat: Chat) { studio.selectChat(chat.id); menuId.value = null; emit('workspace'); }
function toggleEntryMenu(id: string, event: MouseEvent) {
  if (menuId.value === id) { menuId.value = null; return; }
  const anchor = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const menuHeight = 110;
  const menuWidth = 155;
  const gap = 4;
  const top = anchor.bottom + gap + menuHeight <= window.innerHeight
    ? anchor.bottom + gap
    : Math.max(gap, anchor.top - gap - menuHeight);
  menuPosition.value = {
    top: `${top}px`,
    left: `${Math.max(gap, Math.min(anchor.right - menuWidth, window.innerWidth - menuWidth - gap))}px`,
  };
  menuId.value = id;
}
function selectTab(tab: 'chats' | 'projects') {
  activeTab.value = tab; search.value = ''; menuId.value = null;
  if (tab === 'chats') selectedProjectId.value = null;
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
const primaryActionLabel = computed(() => activeTab.value === 'chats' ? t('navigation.newChat') : t('sidebar.newProject'));
function selectProvider(item: ProviderItem, event: Event) {
  if (item.accountId) studio.kieAccountId = item.accountId;
  studio.setProvider(item.id);
  const details = (event.currentTarget as HTMLElement).closest('details') as HTMLDetailsElement | null;
  if (details) details.open = false;
}
function checkProvider() {
  const item = activeProvider.value;
  if (!item) return;
  void loadProviderStatus(item);
  if (item.id === 'media') { studio.requestProviderDiagnostics(); return; }
  statusDialogProvider.value = { ...item };
  statusDialogOpen.value = true;
}
</script>

<template>
  <aside class="sidebar" :class="{ collapsed }">
    <div class="sidebar-brand"><a class="brand-mark" href="/" :aria-label="t('navigation.backHome')" :title="t('navigation.backHome')" @click.prevent="emit('landing')"><img src="/brand-logo.png" alt=""></a><div><strong>{{ t('sidebar.studio') }}</strong><small>WEB · STUDIO</small><span class="sidebar-version">{{ releaseLabel }}</span></div><button type="button" class="collapse-button" :aria-label="t('sidebar.collapse')" @click="collapsed = !collapsed">‹</button></div>
    <nav class="sidebar-primary-nav" :aria-label="t('navigation.main')">
      <a class="sidebar-home-link sidebar-public-home-link" href="/" :aria-label="t('navigation.home')" :title="t('navigation.home')" @click.prevent="emit('landing')">
        <span class="sidebar-home-icon" aria-hidden="true"><svg viewBox="0 0 24 24" role="presentation"><path d="M3.75 10.5 12 3.75l8.25 6.75v8.25a1.5 1.5 0 0 1-1.5 1.5H5.25a1.5 1.5 0 0 1-1.5-1.5V10.5Z" /><path d="M9 20.25v-6h6v6" /></svg></span>
        <span>{{ t('navigation.home') }}</span>
      </a>
      <button type="button" class="sidebar-home-link sidebar-overview-link" :class="{ active: props.activeSection === 'home' }" :aria-label="t('navigation.overview')" :title="t('navigation.overview')" @click="emit('home')">
        <span class="sidebar-home-icon" aria-hidden="true"><svg viewBox="0 0 24 24" role="presentation"><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></svg></span>
        <span>{{ t('navigation.overview') }}</span>
      </button>
      <button type="button" class="sidebar-home-link sidebar-history-link" :class="{ active: props.activeSection === 'history' }" :aria-label="t('navigation.history')" :title="t('navigation.history')" @click="emit('history')">
        <span class="sidebar-home-icon" aria-hidden="true"><svg viewBox="0 0 24 24" role="presentation"><circle cx="12" cy="12" r="8.25" /><path d="M12 7.5v4.75l3.25 2" /></svg></span>
        <span>{{ t('navigation.history') }}</span>
      </button>
      <button type="button" class="sidebar-home-link" :class="{ active: props.activeSection === 'spending' }" :aria-label="t('spending.title')" :title="t('spending.title')" @click="emit('spending')">
        <span class="sidebar-home-icon" aria-hidden="true"><svg viewBox="0 0 24 24" role="presentation"><rect x="3.5" y="5" width="17" height="14" rx="2" /><path d="M3.5 9h17M7 14h4" /></svg></span>
        <span>{{ t('spending.title') }}</span>
      </button>
    </nav>
    <template v-if="!collapsed">
      <div class="sidebar-toolbar"><label class="search"><span aria-hidden="true">⌕</span><input v-model="search" type="search" :placeholder="t('common.search')" :aria-label="t('sidebar.search')" /></label><button class="icon-button" type="button" :aria-label="primaryActionLabel" @click="primaryAdd">＋</button></div>
      <div class="sidebar-tabs" role="tablist"><button type="button" :class="{ active: activeTab === 'chats' }" @click="selectTab('chats')">{{ t('navigation.chats') }}</button><button type="button" :class="{ active: activeTab === 'projects' }" @click="selectTab('projects')">{{ t('navigation.projects') }}</button></div>
      <div v-if="activeTab === 'chats'" class="sidebar-list" @scroll="menuId = null">
        <div class="list-heading"><span>{{ t('sidebar.standaloneChats') }}</span><button type="button" class="subtle-button" :aria-label="t('navigation.newChat')" @click="() => addChat()">＋</button></div>
        <button v-if="studio.systemChat.materialCount" type="button" class="list-item" :class="{ selected: studio.activeChatId === 'system:recent' }" @click="selectChat(studio.systemChat)"><span class="list-icon">✦</span><span><strong>{{ t('navigation.unassigned') }}</strong><small>{{ tp('sidebar.generations', studio.systemChat.materialCount) }}</small></span></button>
        <div v-if="groupedChats.today.length" class="group-label">{{ t('sidebar.today') }}</div>
        <div v-for="chat in groupedChats.today" :key="chat.id" class="sidebar-entry"><button type="button" class="list-item" :class="{ selected: studio.activeChatId === chat.id }" @click="selectChat(chat)"><span class="list-icon">◌</span><span><strong>{{ chat.name }}</strong><small>{{ tp('sidebar.materials', chat.materialCount) }}</small></span></button><button type="button" class="entry-menu" :aria-label="t('sidebar.chatActions')" @click.stop="toggleEntryMenu(chat.id, $event)">•••</button><div v-if="menuId === chat.id" class="entry-actions" :style="menuPosition"><button type="button" @click="renameChat(chat)">{{ t('sidebar.rename') }}</button><button type="button" @click="moveChat(chat)">{{ t('sidebar.move') }}</button><button type="button" @click="archiveChat(chat)">{{ t('sidebar.archive') }}</button></div></div>
        <div v-if="groupedChats.earlier.length" class="group-label">{{ t('navigation.earlier') }}</div>
        <div v-for="chat in groupedChats.earlier" :key="chat.id" class="sidebar-entry"><button type="button" class="list-item" :class="{ selected: studio.activeChatId === chat.id }" @click="selectChat(chat)"><span class="list-icon">◌</span><span><strong>{{ chat.name }}</strong><small>{{ tp('sidebar.materials', chat.materialCount) }}</small></span></button><button type="button" class="entry-menu" :aria-label="t('sidebar.chatActions')" @click.stop="toggleEntryMenu(chat.id, $event)">•••</button><div v-if="menuId === chat.id" class="entry-actions" :style="menuPosition"><button type="button" @click="renameChat(chat)">{{ t('sidebar.rename') }}</button><button type="button" @click="moveChat(chat)">{{ t('sidebar.move') }}</button><button type="button" @click="archiveChat(chat)">{{ t('sidebar.archive') }}</button></div></div>
        <p v-if="!filteredChats.length" class="empty-copy">{{ t('sidebar.noStandaloneChats') }}</p>
      </div>
      <div v-else class="sidebar-list project-list-view" @scroll="menuId = null">
        <div class="list-heading"><span>{{ t('sidebar.workspaces') }}</span><button type="button" class="subtle-button" :aria-label="t('sidebar.newProject')" @click="addProject">＋</button></div>
        <div v-for="project in filteredProjects" :key="project.id" class="project-tree">
          <div class="sidebar-entry"><button type="button" class="list-item project-toggle" :class="{ expanded: selectedProjectId === project.id }" :aria-expanded="selectedProjectId === project.id" @click="openProject(project)"><span class="project-icon">◈</span><span><strong>{{ project.name }}</strong><small>{{ tp('sidebar.chats', project.chatCount) }} · {{ tp('sidebar.materials', project.materialCount) }}</small></span><span class="project-chevron" aria-hidden="true">›</span></button><button type="button" class="entry-menu" :aria-label="t('sidebar.projectActions')" @click.stop="toggleEntryMenu(project.id, $event)">•••</button><div v-if="menuId === project.id" class="entry-actions" :style="menuPosition"><button type="button" @click="renameProject(project)">{{ t('sidebar.rename') }}</button><button type="button" @click="addChat(project.id); menuId = null">{{ t('navigation.newChat') }}</button><button type="button" @click="archiveProject(project)">{{ t('sidebar.archive') }}</button></div></div>
          <div v-if="selectedProjectId === project.id" class="project-children">
            <div v-for="chat in projectChats(project)" :key="chat.id" class="sidebar-entry project-child"><button type="button" class="list-item" :class="{ selected: studio.activeChatId === chat.id }" @click="selectChat(chat)"><span><strong>{{ chat.name }}</strong><small>{{ tp('sidebar.materials', chat.materialCount) }}</small></span></button><button type="button" class="entry-menu" :aria-label="t('sidebar.chatActions')" @click.stop="toggleEntryMenu(chat.id, $event)">•••</button><div v-if="menuId === chat.id" class="entry-actions" :style="menuPosition"><button type="button" @click="renameChat(chat)">{{ t('sidebar.rename') }}</button><button type="button" @click="moveChat(chat)">{{ t('sidebar.move') }}</button><button type="button" @click="archiveChat(chat)">{{ t('sidebar.archive') }}</button></div></div>
            <p v-if="!projectChats(project).length" class="empty-copy project-empty">{{ t('sidebar.noProjectChats') }}</p>
          </div>
        </div>
        <p v-if="!filteredProjects.length" class="empty-copy">{{ t('sidebar.noProjects') }}</p>
      </div>
      <details class="sidebar-provider-menu" @toggle="loadMenuStatuses">
        <summary><span class="sidebar-provider-icon" aria-hidden="true">{{ activeProvider.icon }}</span><span><small>{{ studio.isAdmin ? t('sidebar.supplier') : t('sidebar.modelCatalog') }}</small><strong>{{ activeProvider.label }}</strong><small v-if="studio.isAdmin && statusLabel(activeProvider)" class="sidebar-provider-balance">{{ statusLabel(activeProvider) }}</small></span><span class="sidebar-provider-chevron" aria-hidden="true">⌃</span></summary>
        <div class="sidebar-provider-options" role="menu">
          <div v-for="item in providerItems" :key="item.accountId || item.id" class="sidebar-provider-row"><button type="button" class="sidebar-provider-option" :class="{ active: isActiveProvider(item) }" :data-provider="item.id" :data-kie-account="item.accountId" :disabled="item.configured === false" role="menuitemradio" :aria-checked="isActiveProvider(item)" @click="selectProvider(item, $event)"><span class="provider-option-icon" aria-hidden="true">{{ item.icon }}</span><span><strong>{{ item.label }}</strong><small>{{ item.detail }}</small><small v-if="studio.isAdmin && statusLabel(item)" class="sidebar-provider-balance">{{ statusLabel(item) }}</small></span><span v-if="isActiveProvider(item)" aria-hidden="true">✓</span></button></div>
        </div>
      </details>
      <button v-if="studio.isAdmin" type="button" class="sidebar-provider-check" @click="checkProvider">{{ t('sidebar.checkProvider') }}</button>
    </template>
    <div class="sidebar-bottom"><span class="connection-dot" :class="{ ready: studio.accountReady && !studio.error }"></span><div class="sidebar-status-copy"><span>{{ studio.error ? t('sidebar.offline') : studio.accountReady ? t('sidebar.connected') : t('sidebar.connecting') }}</span><small v-if="startupTimingLabel" class="sidebar-startup-timing">{{ startupTimingLabel }}</small></div></div>
    <Teleport to="body"><div v-if="statusDialogOpen && statusDialogProvider" class="diagnostic-backdrop" @click.self="statusDialogOpen = false"><section class="diagnostic-dialog" role="dialog" aria-modal="true" :aria-label="t('composer.diagnostics')"><header><div><span class="eyebrow">{{ t('composer.diagnosticsEyebrow') }}</span><h2>{{ statusDialogProvider.label }}</h2></div><button type="button" class="dialog-close" :aria-label="t('common.close')" @click="statusDialogOpen = false">×</button></header><div v-if="loadingStatuses.has(statusKey(statusDialogProvider))" class="diagnostic-loading">{{ t('composer.diagnosticsChecking') }}</div><div v-else-if="providerErrors[statusKey(statusDialogProvider)]" class="diagnostic-summary error"><strong>{{ t('composer.diagnosticsUnavailable') }}</strong><span>{{ providerErrors[statusKey(statusDialogProvider)] }}</span></div><template v-else-if="statusFor(statusDialogProvider)"><div class="diagnostic-summary success"><strong>{{ t('composer.diagnosticsOk') }}</strong><span>{{ statusLabel(statusDialogProvider) }}</span></div><div v-if="statusFor(statusDialogProvider)?.windows.length" class="diagnostic-checks"><article v-for="(window, index) in statusFor(statusDialogProvider)?.windows" :key="index" class="ok"><span class="diagnostic-mark">✓</span><div><strong>{{ window.name }}</strong><p>{{ t('sidebar.windowRemaining', { minutes: window.windowMinutes ?? '—', percent: formatNumber(window.remainingPercent, { maximumFractionDigits: 1 }) }) }}<template v-if="window.resetsAt"> · {{ t('sidebar.resetsAt', { time: formatDate(new Date(window.resetsAt * 1000), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) }) }}</template></p></div></article></div></template><footer><button type="button" class="secondary-button" @click="loadProviderStatus(statusDialogProvider)">{{ t('composer.retryCheck') }}</button><button type="button" class="primary-button" @click="statusDialogOpen = false">{{ t('common.close') }}</button></footer></section></div></Teleport>
  </aside>
</template>
