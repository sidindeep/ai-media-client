<script setup lang="ts">
import { computed } from 'vue';
import { useStudioStore } from '../stores/studio';
import type { GenerationRecord } from '../types';

const emit = defineEmits<{ select: [record: GenerationRecord]; workspace: [] }>();
const studio = useStudioStore();
const completedStates = new Set(['success', 'fail', 'blocked', 'unknown', 'unconfirmed', 'cancelled']);
const effortLabels: Record<string, string> = { none: 'Без рассуждения', minimal: 'Минимальный', low: 'Низкий', medium: 'Средний', high: 'Высокий', xhigh: 'Очень высокий', max: 'Максимальный', ultra: 'Ультра' };
const records = computed(() => studio.history.filter(record => completedStates.has(record.state)));

function formatCount(value: number | null | undefined) { return value == null ? '' : value.toLocaleString('ru-RU'); }
function formatDuration(milliseconds: number | null | undefined) {
  if (milliseconds == null) return '';
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  return seconds < 60 ? `${seconds} с` : `${Math.floor(seconds / 60)} мин ${String(seconds % 60).padStart(2, '0')} с`;
}
function timestamp(value?: string) {
  return value ? new Date(value).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
}
function historyMeta(record: GenerationRecord) {
  const total = record.usage?.total_tokens ?? record.usage?.totalTokens;
  const effort = typeof record.input?.effort === 'string' ? effortLabels[record.input.effort] || record.input.effort : '';
  const speed = record.input?.speed === 'fast' ? 'Fast' : record.input?.speed === 'standard' ? 'Обычная' : '';
  return [timestamp(record.createdAt), formatDuration(record.generationDurationMs), record.nativeQuote?.credits != null ? `${formatCount(record.nativeQuote.credits)} кр.` : '', total != null ? `${formatCount(total)} ток.` : '', effort, speed].filter(Boolean).join(' · ');
}
</script>

<template>
  <section class="history-page" aria-labelledby="history-title">
    <header class="history-page-header"><div><span class="eyebrow">ВСЕ РЕЗУЛЬТАТЫ</span><h2 id="history-title">История генераций</h2><p>Завершённые изображения, видео, аудио и текстовые ответы.</p></div><div class="history-page-actions"><span class="history-page-count">{{ records.length }}</span><button type="button" class="history-page-back" @click="emit('workspace')">К генерации</button></div></header>
    <div class="result-history history-page-list"><div class="history-heading"><strong>Завершённые</strong><span>{{ records.length }}</span></div><button v-for="item in records" :key="item.id" type="button" class="history-item" :class="{ selected: studio.selectedId === item.id }" :data-record-id="item.id" @click="emit('select', item)"><span>{{ item.state === 'success' ? '●' : '○' }}</span><span><strong>{{ item.modelName || item.modelId || 'Генерация' }}</strong><small>{{ item.input?.prompt || item.error || 'Без промпта' }}</small><small class="history-item-meta">{{ historyMeta(item) }}</small></span><span class="history-item-arrow" aria-hidden="true">›</span></button><p v-if="!records.length" class="empty-state">Завершённые результаты появятся здесь.</p></div>
  </section>
</template>
