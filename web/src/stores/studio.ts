import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import * as api from '../api/client';
import type { Catalog, CodexCatalog, GenerationRecord, QueueStatus } from '../types';

export const useStudioStore = defineStore('studio', () => {
  const catalog = ref<Catalog | null>(null);
  const codexCatalog = ref<CodexCatalog | null>(null);
  const history = ref<GenerationRecord[]>([]);
  const queue = ref<QueueStatus>({ paused: false, error: null, concurrency: 3 });
  const selectedId = ref<string | null>(null);
  const loading = ref(true);
  const error = ref('');
  const prompt = ref('');
  const provider = ref<'codex' | 'media'>('codex');
  const codexModel = ref('');
  const codexEffort = ref('');
  const codexSpeed = ref('standard');
  const codexKind = ref<'image' | 'text'>('image');
  const codexAspectRatio = ref('auto');
  const pendingCodexId = ref<string | null>(null);

  const selected = computed(() => history.value.find(item => item.id === selectedId.value) || null);
  const active = computed(() => history.value.filter(item => ['queued', 'preparing', 'submitting', 'waiting', 'queuing', 'generating', 'running', 'unknown'].includes(item.state)));
  const completed = computed(() => history.value.filter(item => ['success', 'fail', 'blocked', 'cancelled', 'unconfirmed'].includes(item.state)));
  const currentCodexModel = computed(() => codexCatalog.value?.models.find(model => model.id === codexModel.value) || codexCatalog.value?.models[0]);

  async function refresh() {
    const [nextHistory, nextQueue] = await Promise.all([api.getHistory(), api.getQueueStatus()]);
    history.value = nextHistory;
    queue.value = nextQueue;
    if (selectedId.value && !history.value.some(item => item.id === selectedId.value)) selectedId.value = null;
    if (!selectedId.value && active.value[0]) selectedId.value = active.value[0].id;
  }

  async function initialize() {
    loading.value = true;
    error.value = '';
    try {
      [catalog.value, codexCatalog.value] = await Promise.all([api.getCatalog().catch(() => null), api.getCodexCatalog().catch(() => null)]);
      const defaults = codexCatalog.value?.uiDefaults;
      codexModel.value = defaults?.model || codexCatalog.value?.models.find(model => model.id === 'gpt-6-astra')?.id || codexCatalog.value?.models[0]?.id || '';
      codexEffort.value = defaults?.effort || currentCodexModel.value?.defaultEffort || 'medium';
      codexSpeed.value = defaults?.speed || 'standard';
      codexKind.value = defaults?.kind === 'text' ? 'text' : 'image';
      await refresh();
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : 'Не удалось загрузить студию';
    } finally {
      loading.value = false;
    }
  }

  async function submit() {
    if (!prompt.value.trim()) throw new Error('Введите промпт');
    const requestId = crypto.randomUUID();
    if (provider.value === 'codex') {
      const job = await api.submitCodex({
        prompt: prompt.value,
        model: codexModel.value,
        effort: codexEffort.value,
        speed: codexSpeed.value,
        kind: codexKind.value,
        aspectRatio: codexAspectRatio.value,
        requestId,
      });
      pendingCodexId.value = job.id || requestId;
      prompt.value = '';
      await refresh();
      selectedId.value = `codex:${job.id || requestId}`;
      return job;
    }
    const model = catalog.value?.models[0];
    if (!model) throw new Error('Каталог моделей недоступен');
    const task = await api.createTask({ modelId: model.id, input: { prompt: prompt.value }, requestId });
    prompt.value = '';
    await api.startQueue();
    await refresh();
    selectedId.value = task.id;
    return task;
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

  function select(id: string) {
    selectedId.value = id;
  }

  return {
    catalog, codexCatalog, history, queue, selectedId, selected, active, completed, loading, error,
    prompt, provider, codexModel, codexEffort, codexSpeed, codexKind, codexAspectRatio,
    pendingCodexId, currentCodexModel, initialize, refresh, submit, toggleQueue, remove, select,
  };
});
