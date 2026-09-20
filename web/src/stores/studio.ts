import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import * as api from '../api/client';
import type { Catalog, Chat, CodexCatalog, GenerationRecord, Project, QueueStatus, ReleaseInfo } from '../types';

type GenerationMode = 'text' | 'image' | 'video' | 'audio';
type SourceAttachment = { ref: string; name: string; type: string; fieldKey?: string; [key: string]: unknown };
const ACTIVE_STATES = ['queued', 'preparing', 'submitting', 'waiting', 'queuing', 'generating', 'running'] as const;
const COMPLETED_STATES = ['success', 'fail', 'blocked', 'cancelled', 'unknown', 'unconfirmed'] as const;
const CODEX_POLL_STATES = new Set(['submitting', 'generating', 'running']);
const CODEX_POLL_INTERVAL_MS = 1500;

export const useStudioStore = defineStore('studio', () => {
  const catalog = ref<Catalog | null>(null);
  const codexCatalog = ref<CodexCatalog | null>(null);
  const release = ref<ReleaseInfo | null>(null);
  const history = ref<GenerationRecord[]>([]);
  const projects = ref<Project[]>([]);
  const chats = ref<Chat[]>([]);
  const activeChatId = ref<string>('system:recent');
  const activeProjectId = ref<string | null>(null);
  const queue = ref<QueueStatus>({ paused: false, error: null, concurrency: 3 });
  const selectedId = ref<string | null>(null);
  const loading = ref(true);
  const error = ref('');
  const prompt = ref('');
  const provider = ref<'codex' | 'media'>('codex');
  const mode = ref<GenerationMode>('image');
  const mediaModelId = ref('');
  const mediaInput = ref<Record<string, unknown>>({});
  const sourceFiles = ref<SourceAttachment[]>([]);
  const quantity = ref(1);
  const codexModel = ref('');
  const codexEffort = ref('');
  const codexSpeed = ref('standard');
  const codexKind = ref<'image' | 'text'>('image');
  const codexAspectRatio = ref('auto');
  const pendingCodexId = ref<string | null>(null);
  const draftReady = ref(false);
  let draftTimer: ReturnType<typeof setTimeout> | undefined;
  let codexPollTimer: ReturnType<typeof setInterval> | undefined;
  let codexPollInFlight = false;

  const systemChat = computed<Chat>(() => ({ id: 'system:recent', name: 'Ранее', mode: 'system', projectId: null, context: {}, materialCount: history.value.length }));
  const visibleHistory = computed(() => {
    if (activeChatId.value !== 'system:recent') return history.value.filter(item => item.chatId === activeChatId.value);
    return activeProjectId.value ? history.value.filter(item => item.projectId === activeProjectId.value) : history.value;
  });
  const selected = computed(() => visibleHistory.value.find(item => item.id === selectedId.value) || null);
  const active = computed(() => visibleHistory.value.filter(item => ACTIVE_STATES.includes(item.state as typeof ACTIVE_STATES[number])));
  const accountActive = computed(() => history.value.filter(item => ACTIVE_STATES.includes(item.state as typeof ACTIVE_STATES[number])));
  const completed = computed(() => visibleHistory.value.filter(item => COMPLETED_STATES.includes(item.state as typeof COMPLETED_STATES[number])));
  const currentCodexModel = computed(() => codexCatalog.value?.models.find(model => model.id === codexModel.value) || codexCatalog.value?.models[0]);
  const mediaModels = computed(() => (catalog.value?.models || []).filter(model => (model.kind || 'image') === mode.value));
  const currentMediaModel = computed(() => mediaModels.value.find(model => model.id === mediaModelId.value) || mediaModels.value[0]);

  function normalizeCodexControls() {
    const models = codexCatalog.value?.models || [];
    if (!models.length) return;
    const model = models.find(item => item.id === codexModel.value)
      || models.find(item => item.id === 'gpt-5.5')
      || models.find(item => item.isDefault)
      || models[0];
    codexModel.value = model.id;
    if (!model.efforts.includes(codexEffort.value)) codexEffort.value = model.defaultEffort || model.efforts[0] || 'medium';
    if (!['standard', 'fast'].includes(codexSpeed.value)) codexSpeed.value = 'fast';
    if (!['auto', '1:1', '16:9', '9:16', '3:2', '2:3'].includes(codexAspectRatio.value)) codexAspectRatio.value = 'auto';
  }

  async function refresh() {
    const [nextHistory, nextQueue] = await Promise.all([api.getHistory(), api.getQueueStatus()]);
    history.value = nextHistory;
    queue.value = nextQueue;
    if (selectedId.value && !visibleHistory.value.some(item => item.id === selectedId.value)) selectedId.value = null;
    if (!selectedId.value && (active.value[0] || visibleHistory.value[0])) selectedId.value = (active.value[0] || visibleHistory.value[0]).id;
    syncCodexPolling();
  }

  function codexJobIdsToPoll() {
    return history.value
      .filter(item => item.providerId === 'codex' && CODEX_POLL_STATES.has(item.state))
      .map(item => item.id.startsWith('codex:') ? item.id.slice('codex:'.length) : item.id)
      .filter(id => /^[a-f0-9-]{36}$/.test(id));
  }

  async function pollCodexJobs() {
    if (codexPollInFlight) return;
    const ids = [...new Set(codexJobIdsToPoll())];
    if (!ids.length) { stopCodexPolling(); return; }
    codexPollInFlight = true;
    try {
      const statuses = await Promise.allSettled(ids.map(id => api.getCodexJob(id)));
      if (statuses.some(status => status.status === 'fulfilled')) await refresh();
    } catch {
      // A transient history/queue failure must not stop status reconciliation.
      // The next read-only poll retries without creating another generation.
    } finally {
      codexPollInFlight = false;
    }
  }

  function syncCodexPolling() {
    if (!codexJobIdsToPoll().length) { stopCodexPolling(); return; }
    if (!codexPollTimer) codexPollTimer = setInterval(() => { void pollCodexJobs(); }, CODEX_POLL_INTERVAL_MS);
  }

  function stopCodexPolling() {
    if (codexPollTimer) clearInterval(codexPollTimer);
    codexPollTimer = undefined;
  }

  async function refreshWorkspaces() {
    const [nextProjects, nextChats] = await Promise.all([api.getProjects(), api.getChats()]);
    projects.value = nextProjects;
    chats.value = nextChats;
    if (activeChatId.value !== 'system:recent' && !chats.value.some(chat => chat.id === activeChatId.value)) activeChatId.value = 'system:recent';
    if (activeChatId.value !== 'system:recent') activeProjectId.value = chats.value.find(chat => chat.id === activeChatId.value)?.projectId || null;
    else if (activeProjectId.value && !projects.value.some(project => project.id === activeProjectId.value)) activeProjectId.value = null;
  }

  async function loadDraftForActive() {
    draftReady.value = false;
    const draft = await api.loadDraft(activeChatId.value === 'system:recent' ? null : activeChatId.value).catch(() => null);
    const tab = Array.isArray(draft?.tabs) ? draft.tabs[Number(draft.active) || 0] : null;
    prompt.value = tab && typeof tab === 'object' && typeof tab.prompt === 'string' ? tab.prompt : '';
    if (tab && typeof tab === 'object') {
      if (['text', 'image', 'video', 'audio'].includes(String(tab.mode))) mode.value = tab.mode as GenerationMode;
      if (tab.provider === 'codex' || tab.provider === 'media') provider.value = tab.provider;
      if (typeof tab.mediaModelId === 'string') mediaModelId.value = tab.mediaModelId;
      if (tab.mediaInput && typeof tab.mediaInput === 'object') mediaInput.value = tab.mediaInput as Record<string, unknown>;
      if (Array.isArray(tab.sourceFiles)) sourceFiles.value = tab.sourceFiles.filter((item: { ref?: unknown } | null) => item && typeof item.ref === 'string') as SourceAttachment[];
      if (Number.isInteger(tab.quantity) && Number(tab.quantity) >= 1 && Number(tab.quantity) <= 4) quantity.value = Number(tab.quantity);
      if (typeof tab.codexModel === 'string') codexModel.value = tab.codexModel;
      if (typeof tab.codexEffort === 'string') codexEffort.value = tab.codexEffort;
      if (typeof tab.codexSpeed === 'string') codexSpeed.value = tab.codexSpeed;
      if (typeof tab.codexAspectRatio === 'string') codexAspectRatio.value = tab.codexAspectRatio;
    }
    normalizeCodexControls();
    draftReady.value = true;
  }
  async function saveCurrentDraft() {
    if (!draftReady.value) return;
    const chatId = activeChatId.value === 'system:recent' ? null : activeChatId.value;
    await api.saveDraft({ version: 1, active: 0, tabs: [{ prompt: prompt.value, mode: mode.value, provider: provider.value, mediaModelId: mediaModelId.value, mediaInput: mediaInput.value, sourceFiles: sourceFiles.value, quantity: quantity.value, codexModel: codexModel.value, codexEffort: codexEffort.value, codexSpeed: codexSpeed.value, codexAspectRatio: codexAspectRatio.value }] }, chatId).catch(() => {});
  }

  async function createProject(name: string) { const project = await api.createProject(name); projects.value.unshift(project); return project; }
  async function createChat(name: string, projectId: string | null = null) { const chat = await api.createChat(name, projectId); chats.value.unshift(chat); activeChatId.value = chat.id; activeProjectId.value = chat.projectId || null; await loadDraftForActive(); return chat; }
  async function renameProject(id: string, name: string) { const project = await api.renameProject(id, name); const index = projects.value.findIndex(item => item.id === id); if (index >= 0) projects.value[index] = project; return project; }
  async function renameChat(id: string, name: string) { const chat = await api.renameChat(id, name); const index = chats.value.findIndex(item => item.id === id); if (index >= 0) chats.value[index] = chat; return chat; }
  async function moveChat(id: string, projectId: string | null) { const chat = await api.moveChat(id, projectId); const index = chats.value.findIndex(item => item.id === id); if (index >= 0) chats.value[index] = chat; if (activeChatId.value === id) activeProjectId.value = chat.projectId || null; return chat; }
  async function archiveChat(id: string) { await api.archiveChat(id); chats.value = chats.value.filter(item => item.id !== id); if (activeChatId.value === id) { activeChatId.value = 'system:recent'; activeProjectId.value = null; } }
  async function archiveProject(id: string) { await api.archiveProject(id); projects.value = projects.value.filter(item => item.id !== id); chats.value = chats.value.filter(item => item.projectId !== id); if (activeProjectId.value === id) { activeChatId.value = 'system:recent'; activeProjectId.value = null; } }
  function selectChat(id: string) { activeChatId.value = id; activeProjectId.value = chats.value.find(chat => chat.id === id)?.projectId || null; selectedId.value = visibleHistory.value[0]?.id || null; void loadDraftForActive(); }
  function selectProject(id: string) { activeProjectId.value = id; activeChatId.value = chats.value.find(chat => chat.projectId === id)?.id || 'system:recent'; selectedId.value = visibleHistory.value[0]?.id || null; void loadDraftForActive(); }

  function setMode(value: GenerationMode) {
    mode.value = value;
    if (value === 'text') { provider.value = 'codex'; codexKind.value = 'text'; }
    else if (value === 'image') { codexKind.value = 'image'; if (!['codex', 'media'].includes(provider.value)) provider.value = 'codex'; }
    else { provider.value = 'media'; }
    const first = (catalog.value?.models || []).find(model => (model.kind || 'image') === value);
    if (first && !mediaModels.value.some(model => model.id === mediaModelId.value)) mediaModelId.value = first.id;
  }

  watch(codexModel, normalizeCodexControls, { flush: 'sync' });
  watch([prompt, mode, provider, mediaModelId, mediaInput, sourceFiles, quantity, codexModel, codexEffort, codexSpeed, codexAspectRatio], () => { if (draftTimer) clearTimeout(draftTimer); draftTimer = setTimeout(() => { void saveCurrentDraft(); }, 500); }, { deep: true });
  watch([activeChatId, activeProjectId], () => localStorage.setItem('media-studio-workspace', JSON.stringify({ chatId: activeChatId.value, projectId: activeProjectId.value })));

  async function initialize() {
    loading.value = true;
    error.value = '';
    try {
      try {
        const saved = JSON.parse(localStorage.getItem('media-studio-workspace') || 'null');
        if (saved?.chatId === 'system:recent' || /^[a-f0-9-]{36}$/.test(saved?.chatId || '')) activeChatId.value = saved.chatId;
        if (saved?.projectId === null || /^[a-f0-9-]{36}$/.test(saved?.projectId || '')) activeProjectId.value = saved.projectId;
      } catch { /* ignore damaged browser state */ }
      [catalog.value, codexCatalog.value, release.value] = await Promise.all([api.getCatalog().catch(() => null), api.getCodexCatalog().catch(() => null), api.getRelease().catch(() => null)]);
      const defaults = codexCatalog.value?.uiDefaults;
      const models = codexCatalog.value?.models || [];
      codexModel.value = models.find(model => model.id === defaults?.model)?.id
        || models.find(model => model.id === 'gpt-5.5')?.id
        || models.find(model => model.isDefault)?.id
        || models[0]?.id
        || '';
      codexEffort.value = defaults?.effort || currentCodexModel.value?.defaultEffort || 'medium';
      codexSpeed.value = defaults?.speed || 'standard';
      codexKind.value = defaults?.kind === 'text' ? 'text' : 'image';
      normalizeCodexControls();
      mediaModelId.value = (catalog.value?.models || []).find(model => (model.kind || 'image') === mode.value)?.id || '';
      await Promise.all([refresh(), refreshWorkspaces()]);
      await loadDraftForActive();
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : 'Не удалось загрузить студию';
    } finally {
      loading.value = false;
    }
  }

  async function submit() {
    if (!prompt.value.trim()) throw new Error('Введите промпт');
    const context = { projectId: activeProjectId.value, chatId: activeChatId.value === 'system:recent' ? null : activeChatId.value };
    let last: GenerationRecord | null = null;
    if (provider.value === 'codex') {
      for (let index = 0; index < quantity.value; index++) {
        const requestId = crypto.randomUUID();
        const job = await api.submitCodex({ prompt: prompt.value, model: codexModel.value, effort: codexEffort.value, speed: codexSpeed.value,
          kind: mode.value === 'text' ? 'text' : 'image', aspectRatio: codexAspectRatio.value,
          sourceFiles: mode.value === 'image' ? sourceFiles.value.map(item => item.ref) : [], ...context, requestId });
        pendingCodexId.value = job.id || requestId; last = job;
      }
      prompt.value = ''; await refresh(); selectedId.value = `codex:${last?.id || pendingCodexId.value}`; return last;
    }
    const model = currentMediaModel.value;
    if (!model) throw new Error('Каталог моделей недоступен');
    for (let index = 0; index < quantity.value; index++) {
      last = await api.createTask({ modelId: model.id, input: { ...mediaInput.value, prompt: prompt.value }, sourceFiles: sourceFiles.value, ...context, requestId: crypto.randomUUID() });
    }
    prompt.value = ''; await api.startQueue(); await refresh(); selectedId.value = last?.id || null; return last;
  }

  async function toggleQueue() {
    if (queue.value.paused) await api.startQueue(); else await api.pauseQueue();
    await refresh();
  }

  async function remove(id: string) {
    await api.removeQueued(id);
    if (selectedId.value === id) selectedId.value = null;
    await refresh();
  }

  async function clearWaiting() { await api.clearQueue(); await refresh(); }

  function prepareFrom(record: GenerationRecord) {
    prompt.value = typeof record.input?.prompt === 'string' ? record.input.prompt : '';
    setMode((record.kind === 'video' || record.kind === 'audio' || record.kind === 'text') ? record.kind : 'image');
    if (record.providerId === 'codex') {
      provider.value = 'codex';
      if (record.modelId) codexModel.value = record.modelId;
      if (typeof record.input?.effort === 'string') codexEffort.value = record.input.effort;
      if (typeof record.input?.speed === 'string') codexSpeed.value = record.input.speed;
    } else {
      provider.value = 'media';
      if (record.modelId) mediaModelId.value = record.modelId;
      mediaInput.value = Object.fromEntries(Object.entries(record.input || {}).filter(([key]) => key !== 'prompt'));
    }
  }

  function select(id: string) {
    selectedId.value = id;
  }

  return {
    catalog, codexCatalog, release, history, queue, selectedId, selected, active, accountActive, completed, loading, error,
    prompt, provider, mode, mediaModelId, mediaInput, mediaModels, currentMediaModel, sourceFiles, quantity, setMode,
    codexModel, codexEffort, codexSpeed, codexKind, codexAspectRatio,
    projects, chats, systemChat, activeChatId, activeProjectId, visibleHistory, refreshWorkspaces,
    createProject, createChat, renameProject, renameChat, moveChat, archiveChat, archiveProject, selectChat, selectProject,
    loadDraftForActive,
    pendingCodexId, currentCodexModel, initialize, refresh, stopCodexPolling, submit, toggleQueue, clearWaiting, remove, select, prepareFrom,
  };
});
