<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useStudioStore } from '../stores/studio';
import type { GenerationRecord } from '../types';

const studio = useStudioStore();
const labels: Record<string, string> = {
  success: 'Готово', fail: 'Ошибка', unknown: 'Статус уточняется', unconfirmed: 'Статус уточняется',
  running: 'Генерация', generating: 'Генерация', queued: 'В очереди', preparing: 'Подготовка',
  submitting: 'Отправка', waiting: 'Ожидание', queuing: 'Постановка в очередь', cancelled: 'Отменена', blocked: 'Заблокирована',
};
const effortLabels: Record<string, string> = { none: 'Без рассуждения', minimal: 'Минимальный', low: 'Низкий', medium: 'Средний', high: 'Высокий', xhigh: 'Очень высокий', max: 'Максимальный', ultra: 'Ультра' };
const resultText = computed(() => studio.selected?.output || studio.selected?.error || 'Результат появится здесь после завершения задачи');
const resultUrls = computed(() => {
  if (!studio.selected) return [];
  const local = (studio.selected.localFiles || []).map(file => file.previewUrl || file.url).filter(Boolean) as string[];
  if (local.length) return local;
  try { const value = JSON.parse(studio.selected.resultJson || '{}'); return Array.isArray(value.resultUrls) ? value.resultUrls : []; } catch { return []; }
});
const credits = computed(() => studio.selected?.nativeQuote?.credits);
const usage = computed(() => studio.selected?.usage || null);
const tokens = computed(() => usage.value?.total_tokens ?? usage.value?.totalTokens);
const inputTokens = computed(() => usage.value?.input_tokens ?? usage.value?.inputTokens);
const outputTokens = computed(() => usage.value?.output_tokens ?? usage.value?.outputTokens);
const cachedTokens = computed(() => usage.value?.cached_input_tokens ?? usage.value?.cachedInputTokens);
const reasoningTokens = computed(() => usage.value?.reasoning_output_tokens ?? usage.value?.reasoningOutputTokens);
const now = ref(Date.now());
const refreshing = ref(false);
let timer: ReturnType<typeof setInterval> | undefined;
const activeStates = new Set(['queued', 'preparing', 'submitting', 'waiting', 'queuing', 'generating', 'running']);
function formatDuration(milliseconds: number) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds} с`;
  return `${Math.floor(seconds / 60)} мин ${String(seconds % 60).padStart(2, '0')} с`;
}
function formatCount(value: number | null | undefined) { return value == null ? '—' : value.toLocaleString('ru-RU'); }
function durationFor(record: GenerationRecord, live = false) {
  if (record.generationDurationMs != null) return formatDuration(record.generationDurationMs);
  const startedAt = record.generationStartedAt || record.createdAt;
  const started = startedAt ? Date.parse(startedAt) : Number.NaN;
  return live && activeStates.has(record.state) && Number.isFinite(started) ? formatDuration(now.value - started) : '—';
}
const duration = computed(() => {
  const record = studio.selected;
  return record ? durationFor(record, true) : '—';
});
const isActive = computed(() => Boolean(studio.selected && activeStates.has(studio.selected.state)));
const isCodex = computed(() => studio.selected?.providerId === 'codex');
const route = computed(() => {
  const record = studio.selected;
  if (!record) return '';
  const provider = record.providerName || (record.providerId === 'codex' ? 'Codex CLI' : record.providerId);
  const model = record.modelName || record.modelId || 'Модель не указана';
  const kind = record.kind === 'image' ? 'генератор изображений' : record.kind === 'text' ? 'Текст' : record.kind || 'результат';
  const effort = typeof record.input?.effort === 'string' ? effortLabels[record.input.effort] || record.input.effort : '';
  const speed = record.input?.speed === 'fast' ? '⚡ Fast' : record.input?.speed === 'standard' ? 'Обычная скорость' : '';
  return [provider, model, kind, effort, speed].filter(Boolean).join(' → ');
});
const tokenSummary = computed(() => {
  if (!usage.value) return 'Расход токенов не предоставлен.';
  const details = [`вход: ${formatCount(inputTokens.value)}`, `выход: ${formatCount(outputTokens.value)}`];
  if (cachedTokens.value != null) details.push(`из входных — кэш: ${formatCount(cachedTokens.value)}`);
  if (reasoningTokens.value != null) details.push(`из выходных — рассуждения: ${formatCount(reasoningTokens.value)}`);
  return `Токены: ${formatCount(tokens.value)} (${details.join('; ')}).`;
});
const receipt = computed(() => {
  const record = studio.selected;
  if (!record) return '';
  if (activeStates.has(record.state)) return `${record.providerName || 'Сервис'}: ${labels[record.state] || record.state}. Прошло: ${duration.value}. Итоги по времени и токенам появятся после завершения.`;
  const costAction = record.state === 'success' ? 'Списано' : ['fail', 'blocked', 'cancelled'].includes(record.state) ? 'Возвращено из резерва' : 'Зарезервировано';
  const parts = [record.state === 'success' ? `Ответ получен от ${record.providerName || record.providerId}.` : (record.error || labels[record.state] || record.state) + '.'];
  if (credits.value != null) parts.push(`${costAction}: ${formatCount(credits.value)} кредитов.`);
  if (record.generationDurationMs != null) parts.push(`Время генерации: ${duration.value}.`);
  if (record.providerId === 'codex') parts.push(tokenSummary.value);
  return parts.join(' ');
});
function timestamp(value?: string) { return value ? new Date(value).toLocaleString('ru-RU') : '—'; }
function historyMeta(record: GenerationRecord) {
  const total = record.usage?.total_tokens ?? record.usage?.totalTokens;
  const effort = typeof record.input?.effort === 'string' ? effortLabels[record.input.effort] || record.input.effort : '';
  const speed = record.input?.speed === 'fast' ? 'Fast' : record.input?.speed === 'standard' ? 'Обычная' : '';
  return [timestamp(record.createdAt), durationFor(record), record.nativeQuote?.credits != null ? `${formatCount(record.nativeQuote.credits)} кр.` : '', total != null ? `${formatCount(total)} ток.` : '', effort, speed].filter(Boolean).join(' · ');
}

onMounted(() => { timer = setInterval(() => { now.value = Date.now(); }, 1000); });
onBeforeUnmount(() => { if (timer) clearInterval(timer); });

function prepare(record: GenerationRecord) {
  studio.prepareFrom(record);
  requestAnimationFrame(() => { document.querySelector<HTMLTextAreaElement>('.composer-body textarea')?.focus(); });
}
function openHistory() {
  document.getElementById('chat-history')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
async function refreshStatus() {
  refreshing.value = true;
  try { await studio.refresh(); } finally { refreshing.value = false; }
}
</script>

<template>
  <section class="result-card">
    <div class="panel-heading"><div><span class="eyebrow">РЕЗУЛЬТАТ ЧАТА</span><h2>{{ studio.selected ? labels[studio.selected.state] || studio.selected.state : 'Текущая генерация' }}</h2></div><span class="result-meta">{{ studio.selected?.modelName || studio.selected?.modelId || 'Текущая задача' }}</span></div>
    <p v-if="studio.selected" class="result-route">{{ route }}</p>
    <p v-if="studio.selected" class="result-receipt" role="status">{{ receipt }}</p>
    <div v-if="resultUrls.length" class="result-media">
      <video v-if="studio.selected?.kind === 'video'" :src="resultUrls[0]" controls playsinline></video>
      <audio v-else-if="studio.selected?.kind === 'audio'" :src="resultUrls[0]" controls></audio>
      <img v-else v-for="url in resultUrls" :key="url" :src="url" alt="Результат генерации" />
    </div>
    <pre v-if="studio.selected?.output" class="result-output">{{ studio.selected.output }}</pre>
    <p v-else-if="!resultUrls.length" class="result-placeholder">{{ resultText }}</p>
    <div v-if="studio.selected" class="result-facts"><span>Модель <strong>{{ studio.selected.modelName || studio.selected.modelId || '—' }}</strong></span><span>{{ isActive ? 'Прошло' : 'Время' }} <strong>{{ duration }}</strong></span><span>Цена <strong>{{ formatCount(credits) }}</strong></span><span>Токены <strong>{{ formatCount(tokens) }}</strong></span></div>
    <div v-if="usage" class="token-breakdown"><div><span>Всего токенов</span><strong>{{ formatCount(tokens) }}</strong></div><dl><div><dt>Входные</dt><dd>{{ formatCount(inputTokens) }}</dd></div><div><dt>Выходные</dt><dd>{{ formatCount(outputTokens) }}</dd></div><div v-if="cachedTokens != null"><dt>Кэш из входных</dt><dd>{{ formatCount(cachedTokens) }}</dd></div><div v-if="reasoningTokens != null"><dt>Рассуждения из выходных</dt><dd>{{ formatCount(reasoningTokens) }}</dd></div></dl></div>
    <p v-else-if="isCodex && isActive" class="token-pending">Подсчёт токенов появится после завершения текущей генерации.</p>
    <div v-if="studio.selected" class="timing-details"><span>Запуск <strong>{{ timestamp(studio.selected.generationStartedAt || studio.selected.createdAt) }}</strong></span><span>Завершение <strong>{{ timestamp(studio.selected.generationCompletedAt) }}</strong></span></div>
    <div v-if="studio.selected" class="result-actions"><a v-if="resultUrls[0]" class="action-button" :href="(studio.selected.localFiles?.[0]?.url || resultUrls[0])" download>Скачать</a><button v-if="isActive || ['unknown', 'unconfirmed'].includes(studio.selected.state)" type="button" class="action-button" :disabled="refreshing" @click="refreshStatus">{{ refreshing ? 'Проверяю…' : 'Проверить статус' }}</button><button type="button" class="action-button" @click="prepare(studio.selected)">Повторить</button><button type="button" class="action-button" @click="prepare(studio.selected)">Изменить промпт</button><button type="button" class="action-button" @click="openHistory">Открыть в истории</button></div>
    <div v-if="studio.selected" class="result-footer"><span>{{ studio.selected.input?.prompt || 'Без промпта' }}</span><span>{{ timestamp(studio.selected.createdAt) }}</span></div>
    <div id="chat-history" class="result-history"><div class="history-heading"><strong>Завершённые</strong><span>{{ studio.completed.length }}</span></div><button v-for="item in studio.completed.slice(0, 12)" :key="item.id" type="button" class="history-item" :class="{ selected: studio.selectedId === item.id }" @click="studio.select(item.id)"><span>{{ item.state === 'success' ? '●' : '○' }}</span><span><strong>{{ item.modelName || item.modelId || 'Генерация' }}</strong><small>{{ item.input?.prompt || item.error || 'Без промпта' }}</small><small class="history-item-meta">{{ historyMeta(item) }}</small></span></button><p v-if="!studio.completed.length" class="empty-state">Завершённые результаты появятся здесь.</p></div>
  </section>
</template>
