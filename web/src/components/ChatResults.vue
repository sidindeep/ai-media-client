<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useStudioStore } from '../stores/studio';
import type { GenerationRecord } from '../types';

const emit = defineEmits<{ select: [id: string] }>();
const studio = useStudioStore();
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;

const activeStates = new Set(['queued', 'preparing', 'submitting', 'waiting', 'queuing', 'generating', 'running']);
const statusLabels: Record<string, string> = {
  queued: 'В очереди', preparing: 'Подготовка', submitting: 'Отправка', waiting: 'Ожидание провайдера',
  queuing: 'Очередь провайдера', generating: 'Генерация', running: 'Генерация', success: 'Готово',
  fail: 'Ошибка', blocked: 'Требуется исправление', cancelled: 'Отменена', unknown: 'Статус уточняется',
  unconfirmed: 'Статус уточняется',
};
const effortLabels: Record<string, string> = {
  none: 'Без рассуждения', minimal: 'Минимальный', low: 'Низкий', medium: 'Средний', high: 'Высокий',
  xhigh: 'Очень высокий', max: 'Максимальный', ultra: 'Ультра',
};

const records = computed(() => [...studio.visibleRecords].sort((left, right) => {
  const leftTime = left.createdAt ? Date.parse(left.createdAt) : 0;
  const rightTime = right.createdAt ? Date.parse(right.createdAt) : 0;
  return leftTime - rightTime;
}));

function prompt(record: GenerationRecord) {
  return typeof record.input?.prompt === 'string' && record.input.prompt.trim() ? record.input.prompt : 'Без промпта';
}
function formatCount(value: number | null | undefined) { return value == null ? '' : value.toLocaleString('ru-RU'); }
function timestamp(value?: string) {
  return value ? new Date(value).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
}
function duration(record: GenerationRecord) {
  let milliseconds = record.generationDurationMs;
  if (milliseconds == null && activeStates.has(record.state)) {
    const started = Date.parse(record.generationStartedAt || record.createdAt || '');
    if (Number.isFinite(started)) milliseconds = now.value - started;
  }
  if (milliseconds == null) return '';
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  return seconds < 60 ? `${seconds} с` : `${Math.floor(seconds / 60)} мин ${String(seconds % 60).padStart(2, '0')} с`;
}
function totalTokens(record: GenerationRecord) { return record.usage?.total_tokens ?? record.usage?.totalTokens; }
function meta(record: GenerationRecord) {
  const effort = typeof record.input?.effort === 'string' ? effortLabels[record.input.effort] || record.input.effort : '';
  const speed = record.input?.speed === 'fast' ? 'Fast' : record.input?.speed === 'standard' ? 'Обычная' : '';
  return [
    timestamp(record.createdAt), duration(record),
    record.nativeQuote?.credits != null ? `${formatCount(record.nativeQuote.credits)} кр.` : '',
    totalTokens(record) != null ? `${formatCount(totalTokens(record))} ток.` : '', effort, speed,
  ].filter(Boolean);
}
function resultUrls(record: GenerationRecord) {
  const local = (record.localFiles || []).map(file => file.previewUrl || file.url).filter(Boolean) as string[];
  if (local.length) return local;
  try {
    const value = JSON.parse(record.resultJson || '{}') as { resultUrls?: unknown };
    return Array.isArray(value.resultUrls) ? value.resultUrls.filter(url => typeof url === 'string') : [];
  } catch { return []; }
}
function previewText(record: GenerationRecord) {
  if (record.output) return record.output;
  if (record.error) return record.error;
  return activeStates.has(record.state) ? 'Результат появится здесь после завершения задачи.' : statusLabels[record.state] || record.state;
}
function provider(record: GenerationRecord) {
  return record.providerName || (record.providerId === 'codex' ? 'Codex' : record.providerId === 'media' ? 'Kie.ai' : record.providerId);
}
function select(record: GenerationRecord) { emit('select', record.id); }

async function revealSelected() {
  await nextTick();
  document.querySelector<HTMLElement>(`.chat-result-item[data-record-id="${CSS.escape(studio.selectedId || '')}"]`)
    ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

watch(() => studio.selectedId, () => { void revealSelected(); });
watch(() => records.value.length, () => { void revealSelected(); });
onMounted(() => { timer = setInterval(() => { now.value = Date.now(); }, 1000); void revealSelected(); });
onBeforeUnmount(() => { if (timer) clearInterval(timer); });
</script>

<template>
  <section class="chat-results" aria-label="Результаты текущего чата" aria-live="polite">
    <article v-for="record in records" :key="record.id" class="chat-result-item" :class="{ selected: studio.selectedId === record.id }" :data-record-id="record.id">
      <p class="chat-prompt">{{ prompt(record) }}</p>
      <div class="chat-result-card" role="button" tabindex="0" :aria-label="`Открыть подробности: ${record.modelName || record.modelId || 'генерация'}`" @click="select(record)" @keydown.enter.prevent="select(record)" @keydown.space.prevent="select(record)">
        <header class="chat-result-header">
          <span class="chat-result-state" :class="`state-${record.state}`" aria-hidden="true"></span>
          <span class="chat-result-title"><strong>{{ record.modelName || record.modelId || 'Генерация' }}</strong><small>{{ provider(record) }} · {{ statusLabels[record.state] || record.state }}</small></span>
          <span class="chat-result-arrow" aria-hidden="true">›</span>
        </header>
        <p class="chat-result-prompt">{{ prompt(record) }}</p>
        <div v-if="resultUrls(record).length" class="chat-result-media">
          <video v-if="record.kind === 'video'" :src="resultUrls(record)[0]" controls playsinline @click.stop></video>
          <audio v-else-if="record.kind === 'audio'" :src="resultUrls(record)[0]" controls @click.stop></audio>
          <img v-else v-for="url in resultUrls(record)" :key="url" :src="url" alt="Результат генерации" />
        </div>
        <pre v-else class="chat-result-output" :class="{ pending: activeStates.has(record.state) }">{{ previewText(record) }}</pre>
        <footer class="chat-result-meta"><span v-for="item in meta(record)" :key="item">{{ item }}</span></footer>
      </div>
    </article>
  </section>
</template>
