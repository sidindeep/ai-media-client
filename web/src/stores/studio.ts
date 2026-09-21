import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import * as api from '../api/client';
import type { Catalog, Chat, CodexCatalog, GenerationPreset, GenerationRecord, Project, QueueStatus, ReleaseInfo } from '../types';

type GenerationMode = 'text' | 'image' | 'video' | 'audio';
type SourceAttachment = { ref: string; name: string; type: string; fieldKey?: string; [key: string]: unknown };
const ACTIVE_STATES = ['queued', 'preparing', 'submitting', 'waiting', 'queuing', 'generating', 'running'] as const;
const COMPLETED_STATES = ['success', 'fail', 'blocked', 'cancelled', 'unknown', 'unconfirmed'] as const;
const CODEX_POLL_STATES = new Set(['submitting', 'generating', 'running']);
const CODEX_POLL_INTERVAL_MS = 1500;
const STARTUP_POLL_INTERVAL_MS = 1000;

export const useStudioStore = defineStore('studio', () => {
  const catalog = ref<Catalog | null>(null);
  const codexCatalog = ref<CodexCatalog | null>(null);
  const release = ref<ReleaseInfo | null>(null);
  const history = ref<GenerationRecord[]>([]);
  const pendingSubmissions = ref<GenerationRecord[]>([]);
  const presets = ref<GenerationPreset[]>([]);
  const projects = ref<Project[]>([]);
  const chats = ref<Chat[]>([]);
  const activeChatId = ref<string>('system:recent');
  const activeProjectId = ref<string | null>(null);
  const queue = ref<QueueStatus>({ paused: false, error: null, concurrency: 3 });
  const selectedId = ref<string | null>(null);
  const loading = ref(true);
  const error = ref('');
  const databaseState = ref<'connecting' | 'connected' | 'unavailable' | 'disabled'>('connecting');
  const providerReadiness = ref<'idle' | 'checking' | 'ready' | 'error'>('checking');
  const accountReady = ref(false);
  const prompt = ref('');
  const provider = ref<'codex' | 'media'>('codex');
  const mode = ref<GenerationMode>('image');
  const mediaModelId = ref('');
  const mediaInput = ref<Record<string, unknown>>({});
  const sourceFiles = ref<SourceAttachment[]>([]);
  const codexModel = ref('');
  const codexEffort = ref('');
  const codexSpeed = ref('standard');
  const codexKind = ref<'image' | 'text'>('image');
  const codexAspectRatio = ref('auto');
  const draftReady = ref(false);
  let draftTimer: ReturnType<typeof setTimeout> | undefined;
  let codexPollTimer: ReturnType<typeof setInterval> | undefined;
  let codexPollInFlight = false;
  let startupPollTimer: ReturnType<typeof setTimeout> | undefined;
  let startupPollInFlight = false;

  const systemChat = computed<Chat>(() => ({ id: 'system:recent', name: 'Ранее', mode: 'system', projectId: null, context: {}, materialCount: history.value.length }));
  function recordIsVisible(item: GenerationRecord) {
    if (activeChatId.value !== 'system:recent') return item.chatId === activeChatId.value;
    return activeProjectId.value ? item.projectId === activeProjectId.value : true;
  }
  const visibleHistory = computed(() => history.value.filter(recordIsVisible));
  const visiblePending = computed(() => pendingSubmissions.value.filter(recordIsVisible));
  const visibleRecords = computed(() => [...visiblePending.value, ...visibleHistory.value]);
  const selected = computed(() => visibleRecords.value.find(item => item.id === selectedId.value) || null);
  const active = computed(() => visibleRecords.value.filter(item => ACTIVE_STATES.includes(item.state as typeof ACTIVE_STATES[number])));
  const accountActive = computed(() => [...pendingSubmissions.value, ...history.value].filter(item => ACTIVE_STATES.includes(item.state as typeof ACTIVE_STATES[number])));
  const completed = computed(() => visibleHistory.value.filter(item => COMPLETED_STATES.includes(item.state as typeof COMPLETED_STATES[number])));
  const currentCodexModel = computed(() => codexCatalog.value?.models.find(model => model.id === codexModel.value) || codexCatalog.value?.models[0]);
  const mediaModels = computed(() => (catalog.value?.models || []).filter(model => (model.kind || 'image') === mode.value));
  const currentMediaModel = computed(() => mediaModels.value.find(model => model.id === mediaModelId.value) || mediaModels.value[0]);

  function mediaModelsFor(value: GenerationMode) {
    return (catalog.value?.models || []).filter(model => (model.kind || 'image') === value);
  }

  function normalizeMediaControls() {
    const candidates = mediaModelsFor(mode.value);
    if (!candidates.length) {
      mediaModelId.value = '';
      return;
    }
    if (!candidates.some(model => model.id === mediaModelId.value)) {
      mediaModelId.value = candidates.find(model => model.startupDefault)?.id || candidates[0]?.id || '';
    }
  }

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
    if (selectedId.value && !visibleRecords.value.some(item => item.id === selectedId.value)) selectedId.value = null;
    if (!selectedId.value && (active.value[0] || visibleRecords.value[0])) selectedId.value = (active.value[0] || visibleRecords.value[0]).id;
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
      if (typeof tab.codexModel === 'string') codexModel.value = tab.codexModel;
      if (typeof tab.codexEffort === 'string') codexEffort.value = tab.codexEffort;
      if (typeof tab.codexSpeed === 'string') codexSpeed.value = tab.codexSpeed;
      if (typeof tab.codexAspectRatio === 'string') codexAspectRatio.value = tab.codexAspectRatio;
    }
    normalizeCodexControls();
    normalizeMediaControls();
    draftReady.value = true;
  }
  async function saveCurrentDraft() {
    if (!draftReady.value) return;
    const chatId = activeChatId.value === 'system:recent' ? null : activeChatId.value;
    await api.saveDraft({ version: 1, active: 0, tabs: [{ prompt: prompt.value, mode: mode.value, provider: provider.value, mediaModelId: mediaModelId.value, mediaInput: mediaInput.value, sourceFiles: sourceFiles.value, codexModel: codexModel.value, codexEffort: codexEffort.value, codexSpeed: codexSpeed.value, codexAspectRatio: codexAspectRatio.value }] }, chatId).catch(() => {});
  }

  async function createProject(name: string) { const project = await api.createProject(name); await refreshWorkspaces(); return project; }
  async function createChat(name: string, projectId: string | null = null) { const chat = await api.createChat(name, projectId); await refreshWorkspaces(); activeChatId.value = chat.id; activeProjectId.value = chat.projectId || null; await loadDraftForActive(); return chat; }
  async function renameProject(id: string, name: string) { const project = await api.renameProject(id, name); await refreshWorkspaces(); return project; }
  async function renameChat(id: string, name: string) { const chat = await api.renameChat(id, name); const index = chats.value.findIndex(item => item.id === id); if (index >= 0) chats.value[index] = chat; return chat; }
  async function moveChat(id: string, projectId: string | null) { const chat = await api.moveChat(id, projectId); await refreshWorkspaces(); if (activeChatId.value === id) activeProjectId.value = chat.projectId || null; return chat; }
  async function archiveChat(id: string) { const wasActive = activeChatId.value === id; await api.archiveChat(id); await refreshWorkspaces(); if (wasActive) { activeChatId.value = 'system:recent'; activeProjectId.value = null; await loadDraftForActive(); } }
  async function archiveProject(id: string) { const wasActive = activeProjectId.value === id; await api.archiveProject(id); await refreshWorkspaces(); if (wasActive) { activeChatId.value = 'system:recent'; activeProjectId.value = null; await loadDraftForActive(); } }
  function selectChat(id: string) { activeChatId.value = id; activeProjectId.value = chats.value.find(chat => chat.id === id)?.projectId || null; selectedId.value = visibleRecords.value[0]?.id || null; void loadDraftForActive(); }
  function selectProject(id: string) { activeProjectId.value = id; activeChatId.value = chats.value.find(chat => chat.projectId === id)?.id || 'system:recent'; selectedId.value = visibleRecords.value[0]?.id || null; void loadDraftForActive(); }
  function selectStandalone() { activeProjectId.value = null; if (activeChatId.value !== 'system:recent' && chats.value.find(chat => chat.id === activeChatId.value)?.projectId) activeChatId.value = 'system:recent'; selectedId.value = visibleRecords.value[0]?.id || null; void loadDraftForActive(); }

  function setMode(value: GenerationMode) {
    mode.value = value;
    if (value === 'text') { provider.value = 'codex'; codexKind.value = 'text'; }
    else if (value === 'image') { codexKind.value = 'image'; if (!['codex', 'media'].includes(provider.value)) provider.value = 'codex'; }
    else { provider.value = 'media'; }
    normalizeMediaControls();
  }

  function setProvider(value: 'codex' | 'media') {
    provider.value = value;
    if (value === 'codex') {
      if (!['text', 'image'].includes(mode.value)) mode.value = 'image';
      codexKind.value = mode.value === 'text' ? 'text' : 'image';
      normalizeCodexControls();
    } else {
      if (!['image', 'video', 'audio'].includes(mode.value)) mode.value = 'image';
      normalizeMediaControls();
    }
  }

  function currentPresetPayload(name: string): Omit<GenerationPreset, 'id' | 'createdAt' | 'updatedAt'> | null {
    const base = { name, provider: provider.value, mode: mode.value };
    if (provider.value === 'codex') return {
      ...base,
      provider: 'codex',
      codexModel: codexModel.value,
      codexEffort: codexEffort.value,
      codexSpeed: codexSpeed.value,
      codexAspectRatio: codexAspectRatio.value,
    };
    const model = currentMediaModel.value;
    if (!model) return null;
    const allowed = new Set((model.fields || []).filter(field => field.type !== 'files' && !/prompt/i.test(field.key)).map(field => field.key));
    return {
      ...base,
      provider: 'media',
      mediaModelId: model.id,
      mediaInput: Object.fromEntries(Object.entries(mediaInput.value).filter(([key]) => allowed.has(key))),
    };
  }

  async function saveCurrentPreset(name: string) {
    const payload = currentPresetPayload(name.trim());
    if (!payload) throw new Error('Сначала выберите модель');
    const saved = await api.saveGenerationPreset(payload);
    presets.value = [saved, ...presets.value.filter(item => item.id !== saved.id)];
    return saved;
  }

  async function removePreset(id: string) {
    await api.removeGenerationPreset(id);
    presets.value = presets.value.filter(item => item.id !== id);
  }

  function applyPreset(preset: GenerationPreset) {
    if (preset.provider === 'media') {
      const available = mediaModelsFor(preset.mode).find(model => model.id === preset.mediaModelId);
      if (!available) throw new Error('Модель этого пресета больше недоступна');
      mode.value = preset.mode;
      provider.value = 'media';
      mediaModelId.value = available.id;
      mediaInput.value = JSON.parse(JSON.stringify(preset.mediaInput || {}));
    } else {
      const available = codexCatalog.value?.models.find(model => model.id === preset.codexModel);
      if (!available) throw new Error('Модель Codex этого пресета больше недоступна');
      mode.value = preset.mode === 'text' ? 'text' : 'image';
      provider.value = 'codex';
      codexKind.value = mode.value === 'text' ? 'text' : 'image';
      codexModel.value = available.id;
      codexEffort.value = preset.codexEffort || available.defaultEffort;
      codexSpeed.value = preset.codexSpeed || 'standard';
      codexAspectRatio.value = preset.codexAspectRatio || 'auto';
      normalizeCodexControls();
    }
    sourceFiles.value = [];
  }

  function stable(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, stable(child)]));
    return value;
  }

  function presetMatchesCurrent(preset: GenerationPreset) {
    const current = currentPresetPayload('');
    if (!current) return false;
    const comparable = (value: Partial<GenerationPreset>) => stable(value.provider === 'media' ? {
      provider: value.provider, mode: value.mode,
      mediaModelId: value.mediaModelId, mediaInput: value.mediaInput || {},
    } : {
      provider: value.provider, mode: value.mode,
      codexModel: value.codexModel, codexEffort: value.codexEffort,
      codexSpeed: value.codexSpeed, codexAspectRatio: value.codexAspectRatio,
    });
    return JSON.stringify(comparable(current)) === JSON.stringify(comparable(preset));
  }

  watch(codexModel, normalizeCodexControls, { flush: 'sync' });
  watch([prompt, mode, provider, mediaModelId, mediaInput, sourceFiles, codexModel, codexEffort, codexSpeed, codexAspectRatio], () => { if (!accountReady.value) return; if (draftTimer) clearTimeout(draftTimer); draftTimer = setTimeout(() => { void saveCurrentDraft(); }, 500); }, { deep: true });
  watch([activeChatId, activeProjectId], () => localStorage.setItem('media-studio-workspace', JSON.stringify({ chatId: activeChatId.value, projectId: activeProjectId.value })));

  function restoreWorkspaceSelection() {
    try {
      const saved = JSON.parse(localStorage.getItem('media-studio-workspace') || 'null');
      if (saved?.chatId === 'system:recent' || /^[a-f0-9-]{36}$/.test(saved?.chatId || '')) activeChatId.value = saved.chatId;
      if (saved?.projectId === null || /^[a-f0-9-]{36}$/.test(saved?.projectId || '')) activeProjectId.value = saved.projectId;
    } catch { /* ignore damaged browser state */ }
  }

  async function loadAccountState() {
    loading.value = true;
    error.value = '';
    try {
      [catalog.value, codexCatalog.value, release.value, presets.value] = await Promise.all([api.getCatalog().catch(() => null), api.getCodexCatalog().catch(() => null), api.getRelease().catch(() => null), api.listGenerationPresets()]);
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
      mediaModelId.value = mediaModelsFor(mode.value).find(model => model.startupDefault)?.id || mediaModelsFor(mode.value)[0]?.id || '';
      await Promise.all([refresh(), refreshWorkspaces()]);
      await loadDraftForActive();
      accountReady.value = true;
    } catch (cause) {
      accountReady.value = false;
      const message = cause instanceof Error ? cause.message : 'Не удалось загрузить студию';
      console.error('Account startup failed:', message);
      if (/баз|соедин|connection|timeout|временно недоступ/i.test(message)) databaseState.value = 'unavailable';
      else error.value = message;
    } finally {
      loading.value = false;
    }
  }

  function scheduleStartupPoll() {
    if (startupPollTimer) clearTimeout(startupPollTimer);
    startupPollTimer = setTimeout(() => { startupPollTimer = undefined; void pollStartup(); }, STARTUP_POLL_INTERVAL_MS);
  }

  async function pollStartup() {
    if (startupPollInFlight) return;
    startupPollInFlight = true;
    try {
      const status = await api.getStartupStatus();
      databaseState.value = status.database.state;
      providerReadiness.value = status.provider.state;
      if (['connected', 'disabled'].includes(status.database.state)) {
        if (!status.authenticated) { window.location.assign('/login'); return; }
        if (status.account) api.setAccountContext(status.account);
        if (!accountReady.value) await loadAccountState();
      }
    } catch {
      databaseState.value = 'unavailable';
      accountReady.value = false;
    } finally {
      startupPollInFlight = false;
      if (!accountReady.value || providerReadiness.value === 'checking') scheduleStartupPoll();
    }
  }

  async function initialize() {
    if (startupPollTimer) clearTimeout(startupPollTimer);
    startupPollTimer = undefined;
    accountReady.value = false;
    loading.value = false;
    error.value = '';
    restoreWorkspaceSelection();
    const accountId = document.querySelector('meta[name="account-id"]')?.getAttribute('content') || '';
    const accountRole = document.querySelector('meta[name="account-role"]')?.getAttribute('content') || '';
    if (accountId && accountId !== 'pending' && accountRole && accountRole !== 'pending') {
      // The server already verified this session while serving /app. Reuse that
      // result instead of running the database startup probe again on navigation.
      databaseState.value = 'connected';
      api.setAccountContext({ id: accountId, role: accountRole });
      await loadAccountState();
      if (!accountReady.value) scheduleStartupPoll();
      return;
    }
    await pollStartup();
  }

  function stopStartupPolling() {
    if (startupPollTimer) clearTimeout(startupPollTimer);
    startupPollTimer = undefined;
  }

  async function submit() {
    const submittedPrompt = prompt.value.trim();
    if (!submittedPrompt) throw new Error('Введите промпт');
    const context = { projectId: activeProjectId.value, chatId: activeChatId.value === 'system:recent' ? null : activeChatId.value };
    const requestId = crypto.randomUUID();
    const optimisticId = `pending:${requestId}`;
    const createdAt = new Date().toISOString();
    let optimistic: GenerationRecord;
    if (provider.value === 'codex') {
      const input = { prompt: submittedPrompt, effort: codexEffort.value, speed: codexSpeed.value, aspectRatio: codexAspectRatio.value };
      optimistic = { id: optimisticId, optimistic: true, providerId: 'codex', providerName: 'Codex CLI', modelId: codexModel.value,
        modelName: currentCodexModel.value?.name || codexModel.value, kind: mode.value === 'text' ? 'text' : 'image', state: 'queued',
        createdAt, queuedAt: createdAt, input, ...context };
      pendingSubmissions.value.unshift(optimistic);
      selectedId.value = optimisticId;
      try {
        const job = await api.submitCodex({ ...input, prompt: submittedPrompt, model: codexModel.value,
          kind: mode.value === 'text' ? 'text' : 'image', sourceFiles: sourceFiles.value.map(item => item.ref), ...context, requestId });
        await refresh().catch(() => {});
        pendingSubmissions.value = pendingSubmissions.value.filter(item => item.id !== optimisticId);
        if (selectedId.value === optimisticId) selectedId.value = `codex:${job.id || requestId}`;
        return job;
      } catch (error) {
        pendingSubmissions.value = pendingSubmissions.value.filter(item => item.id !== optimisticId);
        if (selectedId.value === optimisticId) selectedId.value = active.value[0]?.id || visibleHistory.value[0]?.id || null;
        throw error;
      }
    }
    const model = currentMediaModel.value;
    if (!model) throw new Error('Каталог моделей недоступен');
    const input = { ...mediaInput.value };
    if (model.fields?.some(field => field.key === 'prompt')) input.prompt = submittedPrompt;
    optimistic = { id: optimisticId, optimistic: true, providerId: model.providerId || 'media',
      providerName: catalog.value?.providers.find(item => item.id === model.providerId)?.name || 'Kie.ai', modelId: model.id,
      modelName: model.name, kind: model.kind || mode.value, state: 'queued', createdAt, queuedAt: createdAt, input, ...context };
    pendingSubmissions.value.unshift(optimistic);
    selectedId.value = optimisticId;
    try {
      const task = await api.createTask({ modelId: model.id, input, sourceFiles: sourceFiles.value, ...context, requestId });
      await api.startQueue().catch(() => {});
      await refresh().catch(() => {});
      pendingSubmissions.value = pendingSubmissions.value.filter(item => item.id !== optimisticId);
      if (selectedId.value === optimisticId) selectedId.value = task.id;
      return task;
    } catch (error) {
      pendingSubmissions.value = pendingSubmissions.value.filter(item => item.id !== optimisticId);
      if (selectedId.value === optimisticId) selectedId.value = active.value[0]?.id || visibleHistory.value[0]?.id || null;
      throw error;
    }
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
    catalog, codexCatalog, release, history, presets, queue, selectedId, selected, active, accountActive, completed, loading, error,
    databaseState, providerReadiness, accountReady,
    prompt, provider, mode, mediaModelId, mediaInput, mediaModels, currentMediaModel, sourceFiles, setMode, setProvider,
    codexModel, codexEffort, codexSpeed, codexKind, codexAspectRatio,
    projects, chats, systemChat, activeChatId, activeProjectId, visibleHistory, refreshWorkspaces,
    createProject, createChat, renameProject, renameChat, moveChat, archiveChat, archiveProject, selectChat, selectProject, selectStandalone,
    loadDraftForActive,
    currentCodexModel, initialize, refresh, stopCodexPolling, stopStartupPolling, saveCurrentPreset, removePreset, applyPreset, presetMatchesCurrent, submit, toggleQueue, clearWaiting, remove, select, prepareFrom,
  };
});
