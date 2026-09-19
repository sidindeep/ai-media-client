<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useStudioStore } from '../stores/studio';
import type { GenerationRecord } from '../types';

const studio = useStudioStore();
const labels: Record<string, string> = { success: 'Готово', fail: 'Ошибка', unknown: 'Статус уточняется', running: 'Генерация', generating: 'Генерация', queued: 'В очереди', cancelled: 'Отменена', blocked: 'Заблокирована' };
const resultText = computed(() => studio.selected?.output || studio.selected?.error || 'Результат появится здесь после завершения задачи');
const resultUrls = computed(() => {
  if (!studio.selected) return [];
  const local = (studio.selected.localFiles || []).map(file => file.previewUrl || file.url).filter(Boolean) as string[];
  if (local.length) return local;
  try { const value = JSON.parse(studio.selected.resultJson || '{}'); return Array.isArray(value.resultUrls) ? value.resultUrls : []; } catch { return []; }
});
const credits = computed(() => studio.selected?.nativeQuote?.credits);
const tokens = computed(() => studio.selected?.usage?.total_tokens ?? studio.selected?.usage?.totalTokens);
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
const activeStates = new Set(['queued', 'preparing', 'submitting', 'waiting', 'queuing', 'generating', 'running']);
function formatDuration(milliseconds: number) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds} с`;
  return `${Math.floor(seconds / 60)} мин ${seconds % 60} с`;
}
const duration = computed(() => {
  const record = studio.selected;
  if (!record) return '—';
  if (record.generationDurationMs != null) return formatDuration(record.generationDurationMs);
  const startedAt = record.generationStartedAt || record.createdAt;
  const started = startedAt ? Date.parse(startedAt) : Number.NaN;
  return activeStates.has(record.state) && Number.isFinite(started) ? formatDuration(now.value - started) : '—';
});

onMounted(() => { timer = setInterval(() => { now.value = Date.now(); }, 1000); });
onBeforeUnmount(() => { if (timer) clearInterval(timer); });

function prepare(record: GenerationRecord) {
  studio.prepareFrom(record);
  requestAnimationFrame(() => { document.querySelector<HTMLTextAreaElement>('.composer-body textarea')?.focus(); });
}
function openHistory() {
  document.getElementById('chat-history')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
</script>

<template>
  <section class="result-card">
    <div class="panel-heading"><div><span class="eyebrow">РЕЗУЛЬТАТ ЧАТА</span><h2>{{ studio.selected ? labels[studio.selected.state] || studio.selected.state : 'Текущая генерация' }}</h2></div><span class="result-meta">{{ studio.selected?.modelName || studio.selected?.modelId || 'Текущая задача' }}</span></div>
    <div v-if="resultUrls.length" class="result-media">
      <video v-if="studio.selected?.kind === 'video'" :src="resultUrls[0]" controls playsinline></video>
      <audio v-else-if="studio.selected?.kind === 'audio'" :src="resultUrls[0]" controls></audio>
      <img v-else v-for="url in resultUrls" :key="url" :src="url" alt="Результат генерации" />
    </div>
    <pre v-if="studio.selected?.output" class="result-output">{{ studio.selected.output }}</pre>
    <p v-else-if="!resultUrls.length" class="result-placeholder">{{ resultText }}</p>
    <div v-if="studio.selected" class="result-facts"><span>Модель <strong>{{ studio.selected.modelName || studio.selected.modelId || '—' }}</strong></span><span>Время <strong>{{ duration }}</strong></span><span>Цена <strong>{{ credits ?? '—' }}</strong></span><span>Токены <strong>{{ tokens?.toLocaleString('ru-RU') || '—' }}</strong></span></div>
    <div v-if="studio.selected" class="result-actions"><a v-if="resultUrls[0]" class="action-button" :href="(studio.selected.localFiles?.[0]?.url || resultUrls[0])" download>Скачать</a><button type="button" class="action-button" @click="prepare(studio.selected)">Повторить</button><button type="button" class="action-button" @click="prepare(studio.selected)">Изменить промпт</button><button type="button" class="action-button" @click="openHistory">Открыть в истории</button></div>
    <div v-if="studio.selected" class="result-footer"><span>{{ studio.selected.input?.prompt || 'Без промпта' }}</span><span>{{ studio.selected.createdAt ? new Date(studio.selected.createdAt).toLocaleString('ru-RU') : '' }}</span></div>
    <div id="chat-history" class="result-history"><div class="history-heading"><strong>Завершённые</strong><span>{{ studio.completed.length }}</span></div><button v-for="item in studio.completed.slice(0, 12)" :key="item.id" type="button" class="history-item" :class="{ selected: studio.selectedId === item.id }" @click="studio.select(item.id)"><span>{{ item.state === 'success' ? '●' : '○' }}</span><span><strong>{{ item.modelName || item.modelId || 'Генерация' }}</strong><small>{{ item.input?.prompt || item.error || 'Без промпта' }}</small></span></button><p v-if="!studio.completed.length" class="empty-state">Завершённые результаты появятся здесь.</p></div>
  </section>
</template>
