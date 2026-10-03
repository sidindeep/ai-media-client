import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import * as api from '../api/client';
import type { ApimartCatalog, Catalog, Chat, CodexCatalog, RouterAiCatalog, GenerationPreset, GenerationRecord, Project, QueueStatus, ReleaseInfo, ServiceModelConfig, ServiceModelConfigSummary } from '../types';
import { mediaFileValue, normalizeMediaInput } from '../domain/media-fields';
import { t } from '../i18n';

type GenerationMode = 'text' | 'image' | 'video' | 'audio';
export const AUTO_ROUTE_MODEL_ID = 'kie:gpt-image-2-text-to-image';
type SourceAttachment = { ref: string; name: string; type: string; fieldKey?: string; [key: string]: unknown };
type SelectionSnapshot = { sourceFiles: SourceAttachment[]; mediaInput: Record<string, unknown> };
const ACTIVE_STATES = ['queued', 'preparing', 'submitting', 'waiting', 'queuing', 'generating', 'running'] as const;
const COMPLETED_STATES = ['success', 'fail', 'blocked', 'cancelled', 'unknown', 'unconfirmed'] as const;
const CODEX_POLL_STATES = new Set(['queued', 'submitting', 'generating', 'running']);
const CODEX_POLL_INTERVAL_MS = 1500;
const MEDIA_POLL_STATES = new Set(['queued', 'preparing', 'submitting', 'waiting', 'queuing', 'generating']);
const MEDIA_POLL_INTERVAL_MS = 2500;
const STARTUP_POLL_INTERVAL_MS = 1000;
const TERMINAL_STATES = new Set<string>(COMPLETED_STATES);
const STATE_ORDER: Record<string, number> = { queued: 0, preparing: 1, submitting: 2, waiting: 3, queuing: 3, generating: 4, running: 4, success: 5, fail: 5, blocked: 5, cancelled: 5, unknown: 5, unconfirmed: 5 };

export const useStudioStore = defineStore('studio', () => {
  const catalog = ref<Catalog | null>(null);
  const codexCatalog = ref<CodexCatalog | null>(null);
  const routerAiCatalog = ref<RouterAiCatalog | null>(null);
  const apimartCatalog = ref<ApimartCatalog | null>(null);
  const serviceModelConfig = ref<ServiceModelConfig | null>(null);
  const serviceModelConfigs = ref<ServiceModelConfigSummary[]>([]);
  const serviceModelConfigLoading = ref(false);
  const serviceModelConfigError = ref(false);
  const serviceModelChoices = computed(() => {
    const latest = new Map<string, ServiceModelConfigSummary>();
    for (const item of serviceModelConfigs.value) latest.set(item.variant, item);
    return [...latest.values()].sort((a, b) => Number(b.variant === 'all') - Number(a.variant === 'all'));
  });
  async function selectServiceModelConfig(id: string) {
    if (serviceModelConfigLoading.value || serviceModelConfig.value?.id === id) return;
    serviceModelConfigLoading.value = true;
    serviceModelConfigError.value = false;
    try {
      serviceModelConfig.value = await api.getServiceModelConfigById(id);
    } catch {
      serviceModelConfigError.value = true;
    } finally {
      serviceModelConfigLoading.value = false;
    }
  }
  const release = ref<ReleaseInfo | null>(null);
  const history = ref<GenerationRecord[]>([]);
  const historyNext = ref<string | null>(null);
  const historyLoading = ref(false);
  const chatHistoryNext = ref<Record<string, string | null>>({});
  const chatHistoryLoaded = ref<Record<string, boolean>>({});
  const chatHistoryLoading = ref(false);
  const chatHistoryError = ref(false);
  const unassignedCount = ref(0);
  const pendingSubmissions = ref<GenerationRecord[]>([]);
  const presets = ref<GenerationPreset[]>([]);
  const modelFavorites = ref<string[]>([]);
  const modelFavoritesBusy = ref(false);
  const modelFavoritesError = ref(false);
  const modelFavoritesReady = ref(false);
  async function loadModelFavorites() {
    modelFavoritesReady.value = false;
    modelFavoritesError.value = false;
    try {
      modelFavorites.value = await api.getModelFavorites();
      modelFavoritesReady.value = true;
    } catch { modelFavoritesError.value = true; }
  }
  async function toggleModelFavorite(id: string) {
    if (modelFavoritesBusy.value || !modelFavoritesReady.value) return;
    modelFavoritesBusy.value = true;
    modelFavoritesError.value = false;
    try {
      const next = modelFavorites.value.includes(id) ? modelFavorites.value.filter(item => item !== id) : [...modelFavorites.value, id];
      modelFavorites.value = await api.setModelFavorites(next);
    } catch { modelFavoritesError.value = true; }
    finally { modelFavoritesBusy.value = false; }
  }
  const selectedPresetId = ref<string | null>(null);
  const projects = ref<Project[]>([]);
  const chats = ref<Chat[]>([]);
  const activeChatId = ref<string>('system:recent');
  const activeProjectId = ref<string | null>(null);
  const queue = ref<QueueStatus>({ paused: false, error: null, concurrency: 5 });
  const selectedId = ref<string | null>(null);
  const loading = ref(true);
  const error = ref('');
  const databaseState = ref<'connecting' | 'connected' | 'unavailable' | 'disabled'>('connecting');
  const providerReadiness = ref<'idle' | 'checking' | 'ready' | 'error'>('checking');
  const providerDiagnosticRequest = ref(0);
  const accountReady = ref(false);
  const accountRole = ref<'user' | 'admin'>('user');
  const canAdmin = computed(() => accountRole.value === 'admin');
  const userInterface = ref(new URLSearchParams(window.location.search).get('interface') === 'user');
  const isAdmin = computed(() => canAdmin.value && !userInterface.value);
  function toggleInterface() {
    if (!canAdmin.value) return;
    userInterface.value = !userInterface.value;
    const url = new URL(window.location.href);
    if (userInterface.value) url.searchParams.set('interface', 'user');
    else url.searchParams.delete('interface');
    window.history.replaceState(window.history.state, '', url);
  }
  const modelAccess = ref<'gpt-only' | 'all'>('all');
  const fullModelAccess = computed(() => canAdmin.value || modelAccess.value === 'all');
  const connectionElapsedMs = ref<number | null>(null);
  const dataLoadElapsedMs = ref<number | null>(null);
  const readyElapsedMs = ref<number | null>(null);
  const prompt = ref('');
  const provider = ref<'codex' | 'media' | 'routerai' | 'apimart'>('codex');
  const autoRouting = ref(false);
  const autoServiceModelId = ref('');
  const autoOriginModelId = computed(() => provider.value === 'apimart' ? 'apimart:' + apimartModel.value : mediaModelId.value);
  const autoModelId = computed(() => {
    const rows = serviceModelConfig.value?.models || [];
    const matchesOrigin = (row: typeof rows[number]) => row.kind === mode.value
      && (provider.value === 'apimart' ? row.apimart === apimartModel.value : row.kie === mediaModelId.value);
    return rows.find(row => row.id === autoServiceModelId.value && matchesOrigin(row))?.id
      || rows.find(matchesOrigin)?.id || autoOriginModelId.value;
  });
  const kieAccountId = ref<'primary' | 'secondary'>('primary');
  const mode = ref<GenerationMode>('image');
  const mediaModelId = ref('');
  const mediaInput = ref<Record<string, unknown>>({});
  const sourceFiles = ref<SourceAttachment[]>([]);
  const selectionCache = ref<Record<string, SelectionSnapshot>>({});
  const modelByContext = ref<Record<string, string>>({});
  const providerByMode = ref<Partial<Record<GenerationMode, 'codex' | 'media' | 'routerai' | 'apimart'>>>({});
  const codexModel = ref('');
  const routerAiModel = ref('');
  const apimartModel = ref('');
  const codexEffort = ref('');
  const codexSpeed = ref('standard');
  const codexKind = ref<'image' | 'text'>('image');
  const codexAspectRatio = ref('auto');
  const draftReady = ref(false);
  let draftTimer: ReturnType<typeof setTimeout> | undefined;
  let startupStartedAt = 0;
  let dataLoadStartedAt = 0;
  let startupAttempt = 0;
  let syncCursor: string | null = null;
  let syncInFlight: Promise<void> | null = null;
  let chatHistoryInFlight: Promise<void> | null = null;
  let syncAgain = false;
  let preserveNextFullHistory = false;
  let workspaceSelectionRestored = false;

  function resetStartupTimings() {
    // The first attempt includes document navigation; explicit retries start a new measurement.
    startupStartedAt = startupAttempt++ === 0 ? 0 : performance.now();
    dataLoadStartedAt = 0;
    connectionElapsedMs.value = null;
    dataLoadElapsedMs.value = null;
    readyElapsedMs.value = null;
  }

  function markDatabaseConnected() {
    if (connectionElapsedMs.value === null) connectionElapsedMs.value = Math.max(0, Math.round(performance.now() - startupStartedAt));
  }
  let codexPollTimer: ReturnType<typeof setInterval> | undefined;
  let codexPollInFlight = false;
  let mediaPollTimer: ReturnType<typeof setInterval> | undefined;
  let mediaPollInFlight = false;
  let startupPollTimer: ReturnType<typeof setTimeout> | undefined;
  let startupPollInFlight = false;

  const systemChat = computed<Chat>(() => ({ id: 'system:recent', name: t('navigation.unassigned'), mode: 'system', projectId: null, context: {}, materialCount: unassignedCount.value }));
  function recordIsVisible(item: GenerationRecord) {
    if (activeChatId.value !== 'system:recent') return item.chatId === activeChatId.value;
    return !item.chatId;
  }
  const visibleHistory = computed(() => history.value.filter(recordIsVisible));
  const visiblePending = computed(() => {
    const accepted = new Set(history.value.map(item => item.requestId).filter(Boolean));
    return pendingSubmissions.value.filter(item => !item.requestId || !accepted.has(item.requestId)).filter(recordIsVisible);
  });
  const visibleRecords = computed(() => [...visiblePending.value, ...visibleHistory.value]);
  const selected = computed(() => visibleRecords.value.find(item => item.id === selectedId.value) || null);
  const active = computed(() => visibleRecords.value.filter(item => ACTIVE_STATES.includes(item.state as typeof ACTIVE_STATES[number])));
  const accountActive = computed(() => [...pendingSubmissions.value, ...history.value].filter(item => ACTIVE_STATES.includes(item.state as typeof ACTIVE_STATES[number])));
  const completed = computed(() => visibleHistory.value.filter(item => COMPLETED_STATES.includes(item.state as typeof COMPLETED_STATES[number])));
  const currentCodexModel = computed(() => codexCatalog.value?.models.find(model => model.id === codexModel.value) || codexCatalog.value?.models[0]);
  const routerAiModels = computed(() => routerAiCatalog.value?.models.filter(model => model.kind === mode.value
    || mode.value === 'text' && ['embeddings', 'rerank', 'decisions'].includes(model.kind)
    || mode.value === 'audio' && model.kind === 'transcription') || []);
  const currentRouterAiModel = computed(() => routerAiModels.value.find(model => model.id === routerAiModel.value) || routerAiModels.value[0]);
  const apimartModels = computed(() => (apimartCatalog.value?.models || []).filter(model => model.kind === mode.value));
  const currentApimartModel = computed(() => apimartModels.value.find(model => model.id === apimartModel.value) || apimartModels.value[0]);
  const mediaModels = computed(() => (catalog.value?.models || []).filter(model => (model.kind || 'image') === mode.value));
  const currentMediaModel = computed(() => mediaModels.value.find(model => model.id === mediaModelId.value) || mediaModels.value[0]);
  watch([provider, mode, mediaModelId, kieAccountId, canAdmin], () => {
    if (autoRouting.value && (!fullModelAccess.value || !['media', 'apimart'].includes(provider.value)
      || provider.value === 'media' && kieAccountId.value !== 'primary')) autoRouting.value = false;
  });

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

  function normalizeCurrentMediaInput() {
    const model = currentMediaModel.value;
    if (model?.fields) mediaInput.value = normalizeMediaInput(model.fields, mediaInput.value);
  }

  function normalizeCurrentApimartInput() {
    const model = currentApimartModel.value;
    if (model?.fields) mediaInput.value = normalizeMediaInput(model.fields, mediaInput.value);
  }

  function normalizeCurrentProviderInput() {
    if (provider.value === 'media') normalizeCurrentMediaInput();
    else if (provider.value === 'apimart') normalizeCurrentApimartInput();
  }

  function selectionKey() {
    const modelId = provider.value === 'media' ? mediaModelId.value : provider.value === 'codex' ? codexModel.value
      : provider.value === 'apimart' ? apimartModel.value : routerAiModel.value;
    const row = autoRouting.value && serviceModelConfig.value?.models.find(row => row.id === autoServiceModelId.value
      && (provider.value === 'apimart' ? row.apimart === modelId : provider.value === 'media' && row.kie === modelId));
    return `${provider.value}:${mode.value}:${modelId}${row ? ':' + row.id : ''}`;
  }

  function contextKey() { return `${provider.value}:${mode.value}`; }

  function selectedModelId() {
    return provider.value === 'media' ? mediaModelId.value : provider.value === 'codex' ? codexModel.value
      : provider.value === 'apimart' ? apimartModel.value : routerAiModel.value;
  }

  function useRememberedModel() {
    const saved = modelByContext.value[contextKey()];
    if (!saved) return;
    if (provider.value === 'media') mediaModelId.value = saved;
    else if (provider.value === 'codex') codexModel.value = saved;
    else if (provider.value === 'apimart') apimartModel.value = saved;
    else routerAiModel.value = saved;
  }

  function rememberSelection() {
    selectionCache.value[selectionKey()] = { sourceFiles: [...sourceFiles.value], mediaInput: { ...mediaInput.value } };
    modelByContext.value[contextKey()] = selectedModelId();
    providerByMode.value[mode.value] = provider.value;
  }

  function restoreSelection() {
    modelByContext.value[contextKey()] = selectedModelId();
    providerByMode.value[mode.value] = provider.value;
    const saved = selectionCache.value[selectionKey()];
    sourceFiles.value = saved ? [...saved.sourceFiles] : [];
    mediaInput.value = saved ? { ...saved.mediaInput } : {};
    normalizeCurrentProviderInput();
  }

  function carryCompatibleMediaSources(previousModel: typeof currentMediaModel.value | undefined, previousFiles: SourceAttachment[]) {
    if (!previousModel || !currentMediaModel.value || !previousFiles.length) return;
    for (const target of currentMediaModel.value.fields || []) {
      if (target.type !== 'files') continue;
      const source = previousModel.fields?.find(field => field.type === 'files' && field.key === target.key);
      if (!source || target.maxSizeMb && (!source.maxSizeMb || target.maxSizeMb < source.maxSizeMb)) continue;
      const files = previousFiles.filter(file => file.fieldKey === target.key);
      if (!files.length || target.maxFiles && files.length > target.maxFiles || target.scalar && files.length > 1) continue;
      const accepted = (target.accept || '').split(',').map(type => type.trim()).filter(Boolean);
      if (accepted.length && files.some(file => !accepted.some(type => type === file.type
        || type.endsWith('/*') && file.type.startsWith(type.slice(0, -1))))) continue;
      sourceFiles.value = [...sourceFiles.value.filter(file => file.fieldKey !== target.key), ...files];
      mediaInput.value = { ...mediaInput.value, [target.key]: mediaFileValue(target, files.map(file => file.ref)) };
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
    if (!model.efforts.includes(codexEffort.value)) codexEffort.value = model.efforts.includes('low') ? 'low' : model.efforts[0] || 'medium';
    if (!['standard', 'fast'].includes(codexSpeed.value)) codexSpeed.value = 'standard';
    if (!['auto', '1:1', '16:9', '9:16', '3:2', '2:3'].includes(codexAspectRatio.value)) codexAspectRatio.value = 'auto';
  }
  function normalizeRouterAiControls() {
    if (!routerAiModels.value.some(model => model.id === routerAiModel.value)) routerAiModel.value = routerAiModels.value[0]?.id || '';
  }
  function normalizeApimartControls() {
    if (!apimartModels.value.some(model => model.id === apimartModel.value)) apimartModel.value = apimartModels.value.find(model => model.id === 'gpt-4o-mini')?.id || apimartModels.value[0]?.id || '';
  }

  function recomputeWorkspaceCounts() {
    // The server counts all stored records; a paged browser snapshot does not.
    projects.value = projects.value.map(project => ({
      ...project,
      chatCount: chats.value.filter(chat => chat.projectId === project.id).length,
    }));
  }

  function mergeById<T extends { id: string }>(current: T[], changes: T[]) {
    const merged = new Map(current.map(item => [item.id, item]));
    for (const item of changes) merged.set(item.id, item);
    return [...merged.values()];
  }

  function recordTime(item: GenerationRecord) {
    const value = Date.parse(item.updatedAt || item.createdAt || '');
    return Number.isFinite(value) ? value : 0;
  }

  function newestRecord(current: GenerationRecord, incoming: GenerationRecord) {
    const currentRevision = Number(current.revision || 0), incomingRevision = Number(incoming.revision || 0);
    if (currentRevision && incomingRevision && currentRevision !== incomingRevision) return incomingRevision > currentRevision ? incoming : current;
    const currentTerminal = TERMINAL_STATES.has(current.state), incomingTerminal = TERMINAL_STATES.has(incoming.state);
    if (currentTerminal !== incomingTerminal) return incomingTerminal ? incoming : current;
    const currentTime = recordTime(current), incomingTime = recordTime(incoming);
    if (currentTime !== incomingTime) return incomingTime > currentTime ? incoming : current;
    return (STATE_ORDER[incoming.state] ?? -1) >= (STATE_ORDER[current.state] ?? -1) ? incoming : current;
  }

  function mergeGenerationRecords(current: GenerationRecord[], changes: GenerationRecord[], full = false) {
    const incomingIds = new Set(changes.map(item => item.id));
    const merged = new Map((full ? current.filter(item => incomingIds.has(item.id)) : current).map(item => [item.id, item]));
    for (const item of changes) merged.set(item.id, merged.has(item.id) ? newestRecord(merged.get(item.id)!, item) : item);
    return [...merged.values()];
  }

  function reconcilePending() {
    const accepted = new Map(history.value.filter(item => item.requestId).map(item => [item.requestId!, item]));
    const replacements = new Map<string, string>();
    pendingSubmissions.value = pendingSubmissions.value.filter(item => {
      const server = item.requestId ? accepted.get(item.requestId) : undefined;
      if (!server) return true;
      replacements.set(item.id, server.id);
      return false;
    });
    const replacement = selectedId.value ? replacements.get(selectedId.value) : undefined;
    if (replacement) selectedId.value = replacement;
  }

  function acceptServerRecord(optimisticId: string, record: GenerationRecord) {
    history.value = mergeGenerationRecords(history.value, [record]);
    pendingSubmissions.value = pendingSubmissions.value.filter(item => item.id !== optimisticId);
    if (selectedId.value === optimisticId) selectedId.value = record.id;
  }

  function failOptimisticRecord(optimisticId: string, cause: unknown) {
    const completedAt = new Date().toISOString();
    const message = cause instanceof Error ? cause.message : t('studio.loadGenerationError');
    pendingSubmissions.value = pendingSubmissions.value.map(item => item.id === optimisticId ? {
      ...item, optimistic: false, state: 'fail', error: message, updatedAt: completedAt,
      generationCompletedAt: completedAt, generationDurationMs: Math.max(0, Date.parse(completedAt) - Date.parse(item.createdAt || completedAt)),
    } : item);
    selectedId.value = optimisticId;
  }

  function applyWorkspaceSync(snapshot: Awaited<ReturnType<typeof api.getWorkspaceSync>>) {
    syncCursor = snapshot.cursor;
    queue.value = snapshot.queue;
    if (snapshot.full) {
      if (!preserveNextFullHistory) historyNext.value = snapshot.historyNext ?? null;
      unassignedCount.value = snapshot.unassignedCount ?? 0;
    }
    history.value = mergeGenerationRecords(history.value, snapshot.records, snapshot.full && !preserveNextFullHistory)
      .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')) || left.id.localeCompare(right.id));
    if (snapshot.full) preserveNextFullHistory = false;
    reconcilePending();
    const nextProjects = snapshot.full ? snapshot.projects : mergeById(projects.value, snapshot.projects);
    const nextChats = snapshot.full ? snapshot.chats : mergeById(chats.value, snapshot.chats);
    projects.value = nextProjects.filter(project => !project.archivedAt)
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')) || left.id.localeCompare(right.id));
    chats.value = nextChats.filter(chat => !chat.archivedAt)
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')) || left.id.localeCompare(right.id));
    recomputeWorkspaceCounts();
    if (activeChatId.value !== 'system:recent' && !chats.value.some(chat => chat.id === activeChatId.value)) {
      activeChatId.value = chats.value.find(chat => chat.mode === 'system' && !chat.projectId)?.id || chats.value[0]?.id || 'system:recent';
      workspaceSelectionRestored = false;
    }
    if (snapshot.full && activeChatId.value === 'system:recent' && (!workspaceSelectionRestored || systemChat.value.materialCount === 0)) {
      activeChatId.value = chats.value.find(chat => chat.mode === 'system' && !chat.projectId)?.id || chats.value[0]?.id || 'system:recent';
    }
    if (selectedId.value && !visibleRecords.value.some(item => item.id === selectedId.value)) selectedId.value = null;
    if (!selectedId.value && (active.value[0] || visibleRecords.value[0])) selectedId.value = (active.value[0] || visibleRecords.value[0]).id;
    if (activeChatId.value !== 'system:recent') activeProjectId.value = chats.value.find(chat => chat.id === activeChatId.value)?.projectId || null;
    else if (activeProjectId.value && !projects.value.some(project => project.id === activeProjectId.value)) activeProjectId.value = null;
    syncCodexPolling();
    syncMediaPolling();
  }

  async function refresh() {
    if (syncInFlight) {
      syncAgain = true;
      await syncInFlight;
      return;
    }
    syncInFlight = (async () => {
      do {
        syncAgain = false;
        const activeIds = history.value.filter(item => MEDIA_POLL_STATES.has(item.state) || CODEX_POLL_STATES.has(item.state)).map(item => item.id);
        applyWorkspaceSync(await api.getWorkspaceSync(syncCursor, activeIds, activeChatId.value));
      } while (syncAgain);
    })();
    try { await syncInFlight; } finally { syncInFlight = null; }
  }

  async function refreshFull(preserveOlder = true) {
    if (syncInFlight) await syncInFlight.catch(() => {});
    preserveNextFullHistory = preserveOlder && history.value.length > 0;
    syncCursor = null;
    await refresh();
  }
  async function loadOlderHistory() {
    const cursor = historyNext.value;
    if (!cursor || historyLoading.value) return;
    historyLoading.value = true;
    try {
      const page = await api.getHistoryPage(cursor);
      history.value = mergeGenerationRecords(history.value, page.records)
        .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')) || left.id.localeCompare(right.id));
      historyNext.value = page.next;
      if (!selectedId.value && visibleRecords.value[0]) selectedId.value = visibleRecords.value[0].id;
    } finally { historyLoading.value = false; }
  }
  async function loadChatHistory(older = false, chatId = activeChatId.value) {
    if (chatHistoryInFlight) await chatHistoryInFlight.catch(() => {});
    if (!older && chatHistoryLoaded.value[chatId]) return;
    const cursor = older ? chatHistoryNext.value[chatId] : null;
    if (older && !cursor) return;
    const request = (async () => {
      chatHistoryLoading.value = true;
      chatHistoryError.value = false;
      try {
        const page = await api.getChatHistoryPage(chatId, cursor);
        history.value = mergeGenerationRecords(history.value, page.records)
          .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')) || left.id.localeCompare(right.id));
        chatHistoryNext.value = { ...chatHistoryNext.value, [chatId]: page.next };
        chatHistoryLoaded.value = { ...chatHistoryLoaded.value, [chatId]: true };
        if (chatId === activeChatId.value && !selectedId.value && visibleRecords.value[0]) selectedId.value = visibleRecords.value[0].id;
      } catch (cause) {
        if (chatId === activeChatId.value) chatHistoryError.value = true;
        throw cause;
      } finally { chatHistoryLoading.value = false; }
    })();
    chatHistoryInFlight = request;
    try { await request; } finally { if (chatHistoryInFlight === request) chatHistoryInFlight = null; }
  }

  async function refreshAccess() {
    const account = await api.getAccount();
    const next = account.modelPermissions?.modelAccess || account.starterPack?.modelAccess || 'all';
    if (next === modelAccess.value) return;
    setModelAccess(next);
    catalog.value = await api.getCatalog().catch(() => null);
    [routerAiCatalog.value, apimartCatalog.value] = fullModelAccess.value
      ? await Promise.all([api.getRouterAiCatalog().catch(() => null), api.getApimartCatalog().catch(() => null)]) : [null, null];
    normalizeMediaControls();
  }

  function codexJobIdsToPoll() {
    return history.value
      .filter(item => ['codex', 'routerai', 'apimart'].includes(item.providerId) && CODEX_POLL_STATES.has(item.state))
      .map(item => ({ providerId: item.providerId, id: item.id.replace(/^(codex|routerai|apimart):/, '') }))
      .filter(item => /^[a-f0-9-]{36}$/.test(item.id));
  }

  async function pollCodexJobs() {
    if (codexPollInFlight) return;
    const ids = codexJobIdsToPoll();
    if (!ids.length) { stopCodexPolling(); return; }
    codexPollInFlight = true;
    try {
      const statuses = await Promise.allSettled(ids.map(item => item.providerId === 'routerai' ? api.getRouterAiJob(item.id)
        : item.providerId === 'apimart' ? api.getApimartJob(item.id) : api.getCodexJob(item.id)));
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
    await refresh();
  }

  async function loadDraftForActive() {
    draftReady.value = false;
    const draft = await api.loadDraft(activeChatId.value === 'system:recent' ? null : activeChatId.value).catch(() => null);
    const tab = Array.isArray(draft?.tabs) ? draft.tabs[Number(draft.active) || 0] : null;
    if (!tab) { mode.value = 'image'; provider.value = 'codex'; }
    kieAccountId.value = canAdmin.value && tab?.kieAccountId === 'secondary' ? 'secondary' : 'primary';
    prompt.value = tab && typeof tab === 'object' && typeof tab.prompt === 'string' ? tab.prompt : '';
    mediaInput.value = {};
    sourceFiles.value = [];
    selectionCache.value = {};
    modelByContext.value = {};
    providerByMode.value = {};
    autoRouting.value = false;
    if (tab && typeof tab === 'object') {
      if (['text', 'image', 'video', 'audio'].includes(String(tab.mode))) mode.value = tab.mode as GenerationMode;
      if (tab.provider === 'codex' || tab.provider === 'media' || tab.provider === 'routerai'
        || tab.provider === 'apimart' && (canAdmin.value || tab.autoRouting === true && fullModelAccess.value)) provider.value = tab.provider;
      if (typeof tab.mediaModelId === 'string') mediaModelId.value = tab.mediaModelId;
      if (tab.mediaInput && typeof tab.mediaInput === 'object') mediaInput.value = tab.mediaInput as Record<string, unknown>;
      if (Array.isArray(tab.sourceFiles)) sourceFiles.value = tab.sourceFiles.filter((item: { ref?: unknown } | null) => item && typeof item.ref === 'string') as SourceAttachment[];
      if (tab.selectionCache && typeof tab.selectionCache === 'object' && !Array.isArray(tab.selectionCache)) {
        for (const [key, snapshot] of Object.entries(tab.selectionCache as Record<string, unknown>)) {
          if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) continue;
          const entry = snapshot as Partial<SelectionSnapshot>;
          selectionCache.value[key] = {
            sourceFiles: Array.isArray(entry.sourceFiles) ? entry.sourceFiles.filter(item => item && typeof item.ref === 'string') : [],
            mediaInput: entry.mediaInput && typeof entry.mediaInput === 'object' && !Array.isArray(entry.mediaInput) ? entry.mediaInput : {},
          };
        }
      }
      if (tab.modelByContext && typeof tab.modelByContext === 'object' && !Array.isArray(tab.modelByContext)) {
        modelByContext.value = Object.fromEntries(Object.entries(tab.modelByContext as Record<string, unknown>)
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
      }
      if (tab.providerByMode && typeof tab.providerByMode === 'object' && !Array.isArray(tab.providerByMode)) {
        providerByMode.value = Object.fromEntries(Object.entries(tab.providerByMode as Record<string, unknown>)
          .filter(([key, value]) => ['text', 'image', 'video', 'audio'].includes(key) && ['codex', 'media', 'routerai', 'apimart'].includes(String(value)))) as typeof providerByMode.value;
      }
      if (typeof tab.codexModel === 'string') codexModel.value = tab.codexModel;
      if (typeof tab.routerAiModel === 'string') routerAiModel.value = tab.routerAiModel;
      if (typeof tab.apimartModel === 'string') apimartModel.value = tab.apimartModel;
      if (typeof tab.codexEffort === 'string') codexEffort.value = tab.codexEffort;
      if (typeof tab.codexSpeed === 'string') codexSpeed.value = tab.codexSpeed;
      if (typeof tab.codexAspectRatio === 'string') codexAspectRatio.value = tab.codexAspectRatio;
    }
    normalizeCodexControls();
    normalizeRouterAiControls();
    normalizeApimartControls();
    normalizeMediaControls();
    normalizeCurrentProviderInput();
    autoServiceModelId.value = typeof tab?.autoServiceModelId === 'string' ? tab.autoServiceModelId : '';
    autoRouting.value = Boolean(fullModelAccess.value && tab?.autoRouting === true
      && (provider.value === 'apimart' || provider.value === 'media' && kieAccountId.value === 'primary'));
    if (!tab && fullModelAccess.value && (mediaModels.value.length || apimartModels.value.length)) setAutoProvider();
    if (!prompt.value && typeof mediaInput.value.text === 'string') prompt.value = mediaInput.value.text;
    // The active fields in older drafts remain authoritative for the active selection.
    rememberSelection();
    draftReady.value = true;
  }

  function hasMediaJobsToPoll() {
    return history.value.some(item => !['codex', 'routerai', 'apimart'].includes(item.providerId) && MEDIA_POLL_STATES.has(item.state));
  }

  async function pollMediaJobs() {
    if (mediaPollInFlight || !hasMediaJobsToPoll()) { syncMediaPolling(); return; }
    mediaPollInFlight = true;
    try { await refresh(); }
    catch { /* SSE reconnect/full sync remains the fallback. */ }
    finally { mediaPollInFlight = false; syncMediaPolling(); }
  }

  function syncMediaPolling() {
    if (!hasMediaJobsToPoll()) { stopMediaPolling(); return; }
    if (!mediaPollTimer) mediaPollTimer = setInterval(() => { void pollMediaJobs(); }, MEDIA_POLL_INTERVAL_MS);
  }

  function stopMediaPolling() {
    if (mediaPollTimer) clearInterval(mediaPollTimer);
    mediaPollTimer = undefined;
    mediaPollInFlight = false;
  }
  async function saveCurrentDraft() {
    if (!draftReady.value) return;
    rememberSelection();
    const chatId = activeChatId.value === 'system:recent' ? null : activeChatId.value;
    await api.saveDraft({ version: 1, active: 0, tabs: [{ prompt: prompt.value, mode: mode.value, provider: provider.value, autoRouting: autoRouting.value, autoServiceModelId: autoModelId.value, kieAccountId: kieAccountId.value, mediaModelId: mediaModelId.value, mediaInput: mediaInput.value, sourceFiles: sourceFiles.value, selectionCache: selectionCache.value, modelByContext: modelByContext.value, providerByMode: providerByMode.value, codexModel: codexModel.value, routerAiModel: routerAiModel.value, apimartModel: apimartModel.value, codexEffort: codexEffort.value, codexSpeed: codexSpeed.value, codexAspectRatio: codexAspectRatio.value }] }, chatId).catch(() => {});
  }

  async function createProject(name: string) { const project = await api.createProject(name); projects.value = mergeById(projects.value, [project]); recomputeWorkspaceCounts(); return project; }
  async function createChat(name: string, projectId: string | null = null) { const chat = await api.createChat(name, projectId); chats.value = mergeById(chats.value, [chat]); recomputeWorkspaceCounts(); activeChatId.value = chat.id; activeProjectId.value = chat.projectId || null; await loadDraftForActive(); return chat; }
  async function renameProject(id: string, name: string) { const project = await api.renameProject(id, name); projects.value = mergeById(projects.value, [project]); recomputeWorkspaceCounts(); return project; }
  async function renameChat(id: string, name: string) { const chat = await api.renameChat(id, name); const index = chats.value.findIndex(item => item.id === id); if (index >= 0) chats.value[index] = chat; return chat; }
  async function moveChat(id: string, projectId: string | null) { const chat = await api.moveChat(id, projectId); chats.value = mergeById(chats.value, [chat]); recomputeWorkspaceCounts(); if (activeChatId.value === id) activeProjectId.value = chat.projectId || null; return chat; }
  async function archiveChat(id: string) { const wasActive = activeChatId.value === id; await api.archiveChat(id); chats.value = chats.value.filter(chat => chat.id !== id); await refresh(); recomputeWorkspaceCounts(); if (wasActive) { activeChatId.value = chats.value.find(chat => chat.mode === 'system' && !chat.projectId)?.id || chats.value[0]?.id || 'system:recent'; activeProjectId.value = chats.value.find(chat => chat.id === activeChatId.value)?.projectId || null; await loadDraftForActive(); } }
  async function archiveProject(id: string) { const wasActive = activeProjectId.value === id; await api.archiveProject(id); projects.value = projects.value.filter(project => project.id !== id); chats.value = chats.value.filter(chat => chat.projectId !== id); recomputeWorkspaceCounts(); if (wasActive) { activeChatId.value = chats.value.find(chat => chat.mode === 'system' && !chat.projectId)?.id || chats.value[0]?.id || 'system:recent'; activeProjectId.value = chats.value.find(chat => chat.id === activeChatId.value)?.projectId || null; await loadDraftForActive(); } }
  function selectChat(id: string) { activeChatId.value = id; activeProjectId.value = chats.value.find(chat => chat.id === id)?.projectId || null; selectedId.value = visibleRecords.value[0]?.id || null; void loadDraftForActive(); }
  function selectProject(id: string) { activeProjectId.value = id; activeChatId.value = chats.value.find(chat => chat.projectId === id)?.id || 'system:recent'; selectedId.value = visibleRecords.value[0]?.id || null; void loadDraftForActive(); }
  function selectStandalone() { activeProjectId.value = null; if (activeChatId.value !== 'system:recent' && chats.value.find(chat => chat.id === activeChatId.value)?.projectId) activeChatId.value = chats.value.find(chat => chat.mode === 'system' && !chat.projectId)?.id || 'system:recent'; selectedId.value = visibleRecords.value[0]?.id || null; void loadDraftForActive(); }

  function setMode(value: GenerationMode) {
    if (!fullModelAccess.value && ['video', 'audio'].includes(value)) throw new Error(t('studio.mediaLocked'));
    const wasAuto = autoRouting.value;
    rememberSelection();
    mode.value = value;
    const rememberedProvider = providerByMode.value[value];
    if (provider.value !== 'apimart' && rememberedProvider && (rememberedProvider === 'codex' || fullModelAccess.value)
      && (rememberedProvider !== 'routerai' || canAdmin.value || ['text', 'image'].includes(value))
      && (rememberedProvider !== 'apimart' || canAdmin.value)) provider.value = rememberedProvider;
    if (value === 'text') { if (provider.value === 'media') provider.value = 'codex'; codexKind.value = 'text'; }
    else if (value === 'image') { codexKind.value = 'image'; }
    else if (provider.value !== 'apimart' && (provider.value !== 'routerai' || !canAdmin.value)) { provider.value = 'media'; }
    useRememberedModel();
    normalizeMediaControls();
    normalizeRouterAiControls();
    normalizeApimartControls();
    if (provider.value === 'codex') normalizeCodexControls();
    restoreSelection();
    if (wasAuto) {
      if (provider.value !== 'media' && provider.value !== 'apimart') setProvider('apimart', true);
      if (provider.value === 'media' && !mediaModels.value.length) setProvider('apimart', true);
      autoRouting.value = true;
    }
  }

  function setProvider(value: 'codex' | 'media' | 'routerai' | 'apimart', forAuto = false) {
    if (value !== 'codex' && !fullModelAccess.value) throw new Error(t('studio.mediaLocked'));
    if (value === 'apimart' && !canAdmin.value && !forAuto) throw new Error(t('studio.mediaLocked'));
    rememberSelection();
    autoRouting.value = false;
    provider.value = value;
    if (value === 'codex') {
      if (!['text', 'image'].includes(mode.value)) mode.value = 'image';
      useRememberedModel();
      codexKind.value = mode.value === 'text' ? 'text' : 'image';
      normalizeCodexControls();
    } else if (value === 'routerai') {
      if (!canAdmin.value && !['text', 'image'].includes(mode.value)) mode.value = 'image';
      useRememberedModel();
      normalizeRouterAiControls();
    } else if (value === 'apimart') {
      useRememberedModel();
      normalizeApimartControls();
    } else {
      if (!['image', 'video', 'audio'].includes(mode.value)) mode.value = 'image';
      useRememberedModel();
      normalizeMediaControls();
    }
    restoreSelection();
  }

  function setAutoProvider() {
    if (!fullModelAccess.value || !(catalog.value?.models.length || apimartCatalog.value?.models.length))
      throw new Error(t('studio.catalogUnavailable'));
    kieAccountId.value = 'primary';
    if (provider.value !== 'media' && provider.value !== 'apimart') {
      if (mode.value === 'text' || !mediaModels.value.length) setProvider('apimart', true);
      else {
        setProvider('media');
        if (mode.value === 'image' && catalog.value?.models.some(model => model.id === AUTO_ROUTE_MODEL_ID)) {
          setSelectedModel(AUTO_ROUTE_MODEL_ID);
          mediaInput.value = { ...mediaInput.value, resolution: '1K', background: 'opaque' };
        }
      }
    }
    autoRouting.value = true;
    const priced = serviceModelChoices.value.find(item => item.variant === 'all');
    if (priced && serviceModelConfig.value?.id !== priced.id) void selectServiceModelConfig(priced.id);
  }

  function setAutoModel(value: string) {
    if (!autoRouting.value) return;
    const row = serviceModelConfig.value?.models.find(item => item.id === value);
    const useKie = row?.kie && row.kiePrice && row.kiePrice !== '—'
      && catalog.value?.models.some(model => model.id === row.kie);
    const nativeValue = row ? (useKie ? row.kie : row.apimart ? `apimart:${row.apimart}` : row.kie) : value;
    if (!nativeValue) return;
    const target = nativeValue.startsWith('apimart:') ? 'apimart' : 'media';
    const modelId = target === 'apimart' ? nativeValue.slice('apimart:'.length) : nativeValue;
    if (target !== provider.value) setProvider(target, true);
    if (target === 'media') kieAccountId.value = 'primary';
    autoRouting.value = true;
    setSelectedModel(modelId, row?.id || '');
    if (target === 'apimart' && row?.action === 'layer-decomposition')
      mediaInput.value = { ...mediaInput.value, layer_decomposition: true };
  }

  function setSelectedModel(value: string, autoId = '') {
    const previousModel = provider.value === 'media' ? currentMediaModel.value : undefined;
    const previousFiles = [...sourceFiles.value];
    rememberSelection();
    if (provider.value === 'codex') {
      codexModel.value = value;
      const efforts = currentCodexModel.value?.efforts || [];
      codexEffort.value = efforts.includes('low') ? 'low' : efforts[0] || 'medium';
      codexSpeed.value = 'standard';
    }
    else if (provider.value === 'routerai') routerAiModel.value = value;
    else if (provider.value === 'apimart') apimartModel.value = value;
    else mediaModelId.value = value;
    autoServiceModelId.value = autoId;
    restoreSelection();
    if (provider.value === 'media') carryCompatibleMediaSources(previousModel, previousFiles);
  }

  function setModelAccess(value: 'gpt-only' | 'all') {
    rememberSelection();
    modelAccess.value = value;
    if (!fullModelAccess.value) {
      autoRouting.value = false;
      provider.value = 'codex';
      if (!['text', 'image'].includes(mode.value)) mode.value = 'image';
      useRememberedModel();
      normalizeCodexControls();
      restoreSelection();
    }
  }

  function currentPresetPayload(name: string): Omit<GenerationPreset, 'id' | 'createdAt' | 'updatedAt'> | null {
    if (provider.value === 'apimart') return null;
    const base = { name, provider: provider.value, mode: mode.value };
    if (provider.value === 'codex') return {
      ...base,
      provider: 'codex',
      codexModel: codexModel.value,
      codexEffort: codexEffort.value,
      codexSpeed: codexSpeed.value,
      codexAspectRatio: codexAspectRatio.value,
    };
    if (provider.value === 'routerai') return currentRouterAiModel.value ? { ...base, provider: 'routerai', routerAiModel: currentRouterAiModel.value.id } : null;
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

  async function saveCurrentPreset(name: string, id?: string) {
    const payload = currentPresetPayload(name.trim());
    if (!payload) throw new Error(t('studio.selectModel'));
    const saved = await api.saveGenerationPreset(id ? { ...payload, id } : payload);
    presets.value = [saved, ...presets.value.filter(item => item.id !== saved.id)];
    selectedPresetId.value = saved.id;
    return saved;
  }

  async function removePreset(id: string) {
    await api.removeGenerationPreset(id);
    presets.value = presets.value.filter(item => item.id !== id);
    if (selectedPresetId.value === id) selectedPresetId.value = null;
  }

  function applyPreset(preset: GenerationPreset) {
    if (preset.provider === 'media') {
      if (!fullModelAccess.value) throw new Error(t('studio.mediaLocked'));
      const available = mediaModelsFor(preset.mode).find(model => model.id === preset.mediaModelId);
      if (!available) throw new Error(t('studio.presetMediaUnavailable'));
      rememberSelection();
      mode.value = preset.mode;
      provider.value = 'media';
      mediaModelId.value = available.id;
    } else if (preset.provider === 'routerai') {
      const available = routerAiCatalog.value?.models.find(model => model.id === preset.routerAiModel && model.kind === preset.mode);
      if (!available) throw new Error(t('studio.selectModel'));
      rememberSelection();
      mode.value = available.kind === 'transcription' ? 'audio'
        : (available.kind === 'image' || available.kind === 'video' || available.kind === 'audio') ? available.kind : 'text';
      provider.value = 'routerai';
      routerAiModel.value = available.id;
    } else {
      const available = codexCatalog.value?.models.find(model => model.id === preset.codexModel);
      if (!available) throw new Error(t('studio.presetCodexUnavailable'));
      rememberSelection();
      mode.value = preset.mode === 'text' ? 'text' : 'image';
      provider.value = 'codex';
      codexKind.value = mode.value === 'text' ? 'text' : 'image';
      codexModel.value = available.id;
      codexEffort.value = preset.codexEffort || available.defaultEffort;
      codexSpeed.value = preset.codexSpeed || 'standard';
      codexAspectRatio.value = preset.codexAspectRatio || 'auto';
      normalizeCodexControls();
    }
    restoreSelection();
    if (preset.provider === 'media') {
      mediaInput.value = { ...mediaInput.value, ...JSON.parse(JSON.stringify(preset.mediaInput || {})) };
      normalizeCurrentMediaInput();
    }
    selectedPresetId.value = preset.id;
  }

  function stable(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, stable(child)]));
    return value;
  }

  function presetMatchesCurrent(preset: GenerationPreset) {
    const current = currentPresetPayload('');
    if (!current) return false;
    const comparable = (value: Partial<GenerationPreset>) => stable(value.provider === 'routerai' ? {
      provider: value.provider, mode: value.mode, routerAiModel: value.routerAiModel,
    } : value.provider === 'media' ? {
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
  watch([prompt, mode, provider, autoRouting, autoServiceModelId, kieAccountId, mediaModelId, mediaInput, sourceFiles, codexModel, routerAiModel, apimartModel, codexEffort, codexSpeed, codexAspectRatio], () => { if (!accountReady.value) return; if (draftTimer) clearTimeout(draftTimer); draftTimer = setTimeout(() => { void saveCurrentDraft(); }, 500); }, { deep: true });
  watch([activeChatId, activeProjectId], () => localStorage.setItem('media-studio-workspace', JSON.stringify({ chatId: activeChatId.value, projectId: activeProjectId.value })));

  function restoreWorkspaceSelection() {
    workspaceSelectionRestored = false;
    try {
      const saved = JSON.parse(localStorage.getItem('media-studio-workspace') || 'null');
      if (saved?.chatId === 'system:recent' || /^[a-f0-9-]{36}$/.test(saved?.chatId || '')) { activeChatId.value = saved.chatId; workspaceSelectionRestored = true; }
      if (saved?.projectId === null || /^[a-f0-9-]{36}$/.test(saved?.projectId || '')) activeProjectId.value = saved.projectId;
    } catch { /* ignore damaged browser state */ }
  }

  async function loadAccountState() {
    loading.value = true;
    error.value = '';
    history.value = []; historyNext.value = null; preserveNextFullHistory = false;
    chatHistoryNext.value = {}; chatHistoryLoaded.value = {}; chatHistoryError.value = false;
    if (!dataLoadStartedAt) dataLoadStartedAt = performance.now();
    try {
      [catalog.value, codexCatalog.value, routerAiCatalog.value, apimartCatalog.value, serviceModelConfig.value, serviceModelConfigs.value, release.value, presets.value] = await Promise.all([api.getCatalog().catch(() => null), api.getCodexCatalog().catch(() => null), api.getRouterAiCatalog().catch(() => null), fullModelAccess.value ? api.getApimartCatalog().catch(() => null) : Promise.resolve(null), api.getServiceModelConfig().catch(() => null), api.listServiceModelConfigs().catch(() => []), api.getRelease().catch(() => null), api.listGenerationPresets()]);
      const pricedMenu = serviceModelChoices.value.find(item => item.variant === 'all');
      if (pricedMenu && serviceModelConfig.value?.id !== pricedMenu.id) {
        serviceModelConfig.value = await api.getServiceModelConfigById(pricedMenu.id).catch(() => null);
        serviceModelConfigError.value = !serviceModelConfig.value;
      }
      const defaults = codexCatalog.value?.uiDefaults;
      const models = codexCatalog.value?.models || [];
      codexModel.value = models.find(model => model.id === defaults?.model)?.id
        || models.find(model => model.id === 'gpt-5.5')?.id
        || models.find(model => model.isDefault)?.id
        || models[0]?.id
        || '';
      codexEffort.value = currentCodexModel.value?.efforts.includes('low') ? 'low'
        : currentCodexModel.value?.efforts[0] || 'medium';
      codexSpeed.value = 'standard';
      codexKind.value = defaults?.kind === 'text' ? 'text' : 'image';
      normalizeCodexControls();
      normalizeRouterAiControls();
      normalizeApimartControls();
      mediaModelId.value = mediaModelsFor(mode.value).find(model => model.startupDefault)?.id || mediaModelsFor(mode.value)[0]?.id || '';
      syncCursor = null;
      await refresh();
      await loadDraftForActive();
      if (!fullModelAccess.value) provider.value = 'codex';
      const readyAt = performance.now();
      dataLoadElapsedMs.value = Math.max(0, Math.round(readyAt - dataLoadStartedAt));
      readyElapsedMs.value = Math.max(0, Math.round(readyAt - startupStartedAt));
      accountReady.value = true;
    } catch (cause) {
      accountReady.value = false;
      const message = cause instanceof Error ? cause.message : t('studio.loadError');
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
        markDatabaseConnected();
        if (!status.authenticated) { window.location.assign('/login'); return; }
        if (status.account) {
          accountRole.value = status.account.role === 'admin' ? 'admin' : 'user';
          setModelAccess(status.account.modelPermissions?.modelAccess || status.account.starterPack?.modelAccess || 'all');
          api.setAccountContext(status.account);
        }
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
    resetStartupTimings();
    restoreWorkspaceSelection();
    const accountId = document.querySelector('meta[name="account-id"]')?.getAttribute('content') || '';
    const documentAccountRole = document.querySelector('meta[name="account-role"]')?.getAttribute('content') || '';
    const documentModelAccess = document.querySelector('meta[name="account-model-access"]')?.getAttribute('content') || '';
    if (accountId && accountId !== 'pending' && documentAccountRole && documentAccountRole !== 'pending') {
      // The server already verified this session while serving /app. Reuse that
      // result instead of running the database startup probe again on navigation.
      databaseState.value = 'connected';
      markDatabaseConnected();
      accountRole.value = documentAccountRole === 'admin' ? 'admin' : 'user';
      setModelAccess(documentModelAccess === 'gpt-only' ? 'gpt-only' : 'all');
      api.setAccountContext({ id: accountId, role: documentAccountRole });
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

  async function submit(routerAiPayload?: Record<string, unknown>, quotedAmountUnits?: number, autoRoute = false) {
    const submittedProvider = provider.value;
    const submittedAutoModelId = autoModelId.value;
    const submittedAutoOrigin = autoOriginModelId.value;
    const submittedKieAccount = canAdmin.value ? kieAccountId.value : 'primary';
    const submittedCodexModel = codexModel.value;
    const submittedCodexModelName = currentCodexModel.value?.name || submittedCodexModel;
    const submittedCodexEffort = codexEffort.value;
    const submittedCodexSpeed = codexSpeed.value;
    const submittedCodexAspectRatio = codexAspectRatio.value;
    const submittedMode = mode.value;
    const submittedRouterAiModel = currentRouterAiModel.value;
    const submittedApimartModel = currentApimartModel.value;
    const submittedMediaModel = currentMediaModel.value;
    if (submittedProvider === 'media') normalizeCurrentMediaInput();
    else if (submittedProvider === 'apimart') normalizeCurrentApimartInput();
    const submittedMediaInput = { ...mediaInput.value };
    const submittedSourceFiles = [...sourceFiles.value];
    const submittedPrompt = prompt.value.trim() || (submittedProvider === 'routerai' && submittedRouterAiModel?.kind === 'transcription'
      ? t('routerai.admin.transcriptionPrompt') : '');
    if (!submittedPrompt && submittedProvider !== 'media' && !(submittedProvider === 'apimart' && !submittedApimartModel?.promptRequired)) throw new Error(t('studio.enterPrompt'));
    if (activeChatId.value === 'system:recent') {
      let target = chats.value.find(chat => chat.mode === 'system' && chat.projectId === activeProjectId.value);
      if (!target) {
        target = await api.createChat(t('navigation.mainChat'), activeProjectId.value);
        chats.value = mergeById(chats.value, [target]);
        recomputeWorkspaceCounts();
      }
      activeChatId.value = target.id;
      await saveCurrentDraft();
    }
    const context = { projectId: activeProjectId.value, chatId: activeChatId.value === 'system:recent' ? null : activeChatId.value };
    const requestId = crypto.randomUUID();
    const optimisticId = `pending:${requestId}`;
    const createdAt = new Date().toISOString();
    let optimistic: GenerationRecord;
    if (submittedProvider === 'codex') {
      const input = { prompt: submittedPrompt, effort: submittedCodexEffort, speed: submittedCodexSpeed, aspectRatio: submittedCodexAspectRatio };
      optimistic = { id: optimisticId, requestId, optimistic: true, providerId: 'codex', providerName: 'Codex CLI', modelId: submittedCodexModel,
        modelName: submittedCodexModelName, kind: submittedMode === 'text' ? 'text' : 'image', state: 'queued',
        createdAt, queuedAt: createdAt, input, ...context };
      pendingSubmissions.value.unshift(optimistic);
      selectedId.value = optimisticId;
      try {
        const job = await api.submitCodex({ ...input, prompt: submittedPrompt, model: submittedCodexModel,
          kind: submittedMode === 'text' ? 'text' : 'image', sourceFiles: submittedSourceFiles.map(item => item.ref), ...context, requestId });
        await refresh().catch(() => {});
        return job;
      } catch (error) {
        await refreshFull().catch(() => {});
        const accepted = history.value.find(item => item.requestId === requestId);
        if (accepted) { acceptServerRecord(optimisticId, accepted); return accepted; }
        failOptimisticRecord(optimisticId, error);
        throw error;
      }
    }
    if (submittedProvider === 'apimart') {
      const model = submittedApimartModel;
      if (!model) throw new Error(t('studio.selectModel'));
      optimistic = { id: optimisticId, requestId, optimistic: true, providerId: 'apimart', providerName: 'APIMart',
        modelId: model.id, modelName: model.name, kind: model.kind, state: 'queued', createdAt, queuedAt: createdAt,
        input: { prompt: submittedPrompt, ...submittedMediaInput }, ...context };
      pendingSubmissions.value.unshift(optimistic);
      selectedId.value = optimisticId;
      try {
        const job = autoRoute
          ? await api.submitAutoRoute({ requestId, modelId: `apimart:${model.id}`,
            input: { prompt: submittedPrompt, ...(model.kind !== 'text' ? submittedMediaInput : {}) }, ...context })
          : await api.submitApimart({ requestId, model: model.id, prompt: submittedPrompt,
            parameters: model.kind !== 'text' ? submittedMediaInput : {}, ...context });
        await refresh().catch(() => {});
        return job;
      } catch (error) {
        await refreshFull().catch(() => {});
        const accepted = history.value.find(item => item.requestId === requestId);
        if (accepted) { acceptServerRecord(optimisticId, accepted); return accepted; }
        failOptimisticRecord(optimisticId, error);
        throw error;
      }
    }
    if (submittedProvider === 'routerai') {
      const model = submittedRouterAiModel;
      if (!model) throw new Error(t('studio.selectModel'));
      optimistic = { id: optimisticId, requestId, optimistic: true, providerId: 'routerai', providerName: 'RouterAI',
        modelId: model.id, modelName: model.name, kind: model.kind, state: 'queued', createdAt, queuedAt: createdAt,
        input: { prompt: submittedPrompt }, ...context };
      pendingSubmissions.value.unshift(optimistic);
      selectedId.value = optimisticId;
      try {
        const job = ['text', 'image'].includes(model.kind)
          ? await api.submitRouterAi({ requestId, model: model.id, prompt: submittedPrompt, quotedAmountUnits, ...context })
          : await api.submitRouterAiAdmin({ requestId, model: model.id, payload: routerAiPayload || {}, quotedAmountUnits, ...context });
        await refresh().catch(() => {});
        return job;
      } catch (error) {
        await refreshFull().catch(() => {});
        const accepted = history.value.find(item => item.requestId === requestId);
        if (accepted) { acceptServerRecord(optimisticId, accepted); return accepted; }
        failOptimisticRecord(optimisticId, error);
        throw error;
      }
    }
    if (!fullModelAccess.value) throw new Error(t('studio.mediaLocked'));
    const model = submittedMediaModel;
    if (!model) throw new Error(t('studio.catalogUnavailable'));
    const input = { ...submittedMediaInput };
    const unionSchemas = (model.inputSchema?.oneOf || model.inputSchema?.anyOf || []) as Array<{ properties?: Record<string, unknown> }>;
    if (model.fields?.some(field => field.key === 'prompt') || unionSchemas.some(schema => Boolean(schema.properties?.prompt))) input.prompt = submittedPrompt;
    else if (model.fields?.some(field => field.key === 'text')) input.text = submittedPrompt;
    optimistic = { id: optimisticId, requestId, optimistic: true, kieAccountId: submittedKieAccount, providerId: model.providerId || 'media',
      providerName: catalog.value?.kieAccounts?.find(item => item.id === submittedKieAccount)?.name || 'Kie.ai', modelId: model.id,
      modelName: model.name, kind: model.kind || submittedMode, state: 'queued', createdAt, queuedAt: createdAt, input, ...context };
    pendingSubmissions.value.unshift(optimistic);
    selectedId.value = optimisticId;
    try {
      const task = autoRoute
        ? await api.submitAutoRoute({ modelId: submittedAutoModelId, originModelId: submittedAutoOrigin, input, sourceFiles: submittedSourceFiles, ...context, requestId })
        : await api.createTask({ modelId: model.id, input, sourceFiles: submittedSourceFiles, ...context, requestId, kieAccountId: submittedKieAccount });
      if (!autoRoute) acceptServerRecord(optimisticId, task);
      await refresh().catch(() => {});
      return task;
    } catch (error) {
      await refreshFull().catch(() => {});
      const accepted = history.value.find(item => item.requestId === requestId);
      if (accepted) { acceptServerRecord(optimisticId, accepted); return accepted; }
      failOptimisticRecord(optimisticId, error);
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
    await refreshFull(false);
  }

  async function clearWaiting() {
    await api.clearQueue();
    if (selectedId.value && accountActive.value.some(item => item.id === selectedId.value && !['codex', 'routerai'].includes(item.providerId))) selectedId.value = null;
    await refreshFull(false);
  }

  function prepareFrom(record: GenerationRecord) {
    prompt.value = typeof record.input?.prompt === 'string' ? record.input.prompt : typeof record.input?.text === 'string' ? record.input.text : '';
    setMode((record.kind === 'video' || record.kind === 'audio' || record.kind === 'text') ? record.kind : 'image');
    rememberSelection();
    if (record.providerId === 'codex') {
      provider.value = 'codex';
      if (record.modelId) codexModel.value = record.modelId;
      if (typeof record.input?.effort === 'string') codexEffort.value = record.input.effort;
      if (typeof record.input?.speed === 'string') codexSpeed.value = record.input.speed;
    } else if (record.providerId === 'apimart') {
      provider.value = 'apimart';
      if (record.modelId) apimartModel.value = record.modelId;
    } else if (record.providerId === 'routerai') {
      const selectedModel = routerAiCatalog.value?.models.find(model => model.id === record.modelId);
      if (selectedModel?.kind === 'transcription') mode.value = 'audio';
      else if (selectedModel && ['embeddings', 'rerank', 'decisions'].includes(selectedModel.kind)) mode.value = 'text';
      provider.value = 'routerai';
      if (record.modelId) routerAiModel.value = record.modelId;
    } else {
      provider.value = 'media';
      kieAccountId.value = canAdmin.value && record.kieAccountId === 'secondary' ? 'secondary' : 'primary';
      if (record.modelId) mediaModelId.value = record.modelId;
    }
    restoreSelection();
    if (record.providerId === 'apimart') {
      mediaInput.value = Object.fromEntries(Object.entries(record.input || {}).filter(([key]) => key !== 'prompt'));
      normalizeCurrentApimartInput();
    }
    if (record.providerId !== 'codex' && record.providerId !== 'routerai' && record.providerId !== 'apimart') {
      mediaInput.value = Object.fromEntries(Object.entries(record.input || {}).filter(([key]) => key !== 'prompt'));
      normalizeCurrentMediaInput();
    }
  }

  function select(id: string) {
    selectedId.value = id;
  }
  function requestProviderDiagnostics() {
    providerDiagnosticRequest.value++;
  }

  return {
    modelFavorites, modelFavoritesBusy, modelFavoritesError, modelFavoritesReady, loadModelFavorites, toggleModelFavorite,
    catalog, codexCatalog, routerAiCatalog, apimartCatalog, serviceModelConfig, serviceModelConfigs, serviceModelChoices, serviceModelConfigLoading, serviceModelConfigError, selectServiceModelConfig, release, history, historyNext, historyLoading, loadOlderHistory, chatHistoryNext, chatHistoryLoaded, chatHistoryLoading, chatHistoryError, loadChatHistory, presets, selectedPresetId, queue, selectedId, selected, active, accountActive, completed, loading, error,
    databaseState, providerReadiness, providerDiagnosticRequest, accountReady, accountRole, canAdmin, userInterface, toggleInterface, isAdmin, modelAccess, fullModelAccess, connectionElapsedMs, dataLoadElapsedMs, readyElapsedMs,
    prompt, provider, autoRouting, autoModelId, autoOriginModelId, kieAccountId, mode, mediaModelId, mediaInput, mediaModels, currentMediaModel, sourceFiles, setMode, setProvider, setAutoProvider, setAutoModel, setSelectedModel, setModelAccess,
    codexModel, routerAiModel, routerAiModels, currentRouterAiModel, apimartModel, apimartModels, currentApimartModel, codexEffort, codexSpeed, codexKind, codexAspectRatio,
    projects, chats, systemChat, activeChatId, activeProjectId, visibleHistory, visibleRecords, refreshWorkspaces,
    createProject, createChat, renameProject, renameChat, moveChat, archiveChat, archiveProject, selectChat, selectProject, selectStandalone,
    loadDraftForActive,
    currentCodexModel, initialize, refresh, refreshFull, refreshAccess, stopCodexPolling, stopMediaPolling, stopStartupPolling, saveCurrentPreset, removePreset, applyPreset, presetMatchesCurrent, submit, toggleQueue, clearWaiting, remove, select, prepareFrom, requestProviderDiagnostics,
  };
});
