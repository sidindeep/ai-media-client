<script setup lang="ts">
import { computed } from 'vue';
import { useStudioStore } from '../stores/studio';
import type { GenerationRecord } from '../types';

const studio = useStudioStore();
const labels: Record<string, string> = { queued: 'В нашей очереди — ещё не отправлено', preparing: 'Подготовка — ещё не отправлено', submitting: 'Отправка', waiting: 'Ожидание провайдера', queuing: 'Очередь провайдера', generating: 'Генерация', running: 'Генерация', unknown: 'Статус отправки уточняется', success: 'Готово', fail: 'Ошибка', blocked: 'Требуется исправление', cancelled: 'Отменена', unconfirmed: 'Нужна сверка' };
const removableStates = new Set(['queued', 'preparing', 'submitting', 'waiting', 'queuing', 'generating', 'unknown', 'blocked']);
const removableItems = computed(() => studio.history.filter(item => item.providerId !== 'codex' && removableStates.has(item.state)));
const sentStates = new Set(['submitting', 'waiting', 'queuing', 'generating', 'unknown']);
function sentToKie(item: GenerationRecord) {
  return Boolean(item.providerAcceptedAt || sentStates.has(item.state));
}
function canRemove(item: GenerationRecord) {
  return !item.optimistic && item.providerId !== 'codex';
}
async function removeItem(item: GenerationRecord) {
  if (sentToKie(item) && !confirm('Kie уже получил или мог получить эту задачу. Токены Kie могли быть списаны: удаление не отменит генерацию и не вернёт списание. Удалить запись полностью?')) return;
  await studio.remove(item.id);
}
async function clearAll() {
  if (removableItems.value.some(sentToKie) && !confirm('Среди задач есть уже отправленные в Kie. Токены Kie могли быть списаны: очистка не отменит генерации и не вернёт списания. Удалить все записи очереди полностью?')) return;
  await studio.clearWaiting();
}
function statusLabel(item: { providerId: string; state: string; optimistic?: boolean }) {
  if (item.optimistic) return 'Добавляется в очередь';
  if (['media', 'kie'].includes(item.providerId)) return ({ submitting: 'Отправляем в Kie.ai', waiting: 'Генерируется в Kie.ai', queuing: 'В очереди Kie.ai', generating: 'Генерируется в Kie.ai' } as Record<string, string>)[item.state] || labels[item.state] || item.state;
  return labels[item.state] || item.state;
}
</script>

<template>
  <section class="queue-card">
    <div class="panel-heading"><div><span class="eyebrow">ОЧЕРЕДЬ ЧАТА</span><h2>{{ studio.active.length ? `${studio.active.length} активных задач` : 'Нет активных задач' }}</h2><small v-if="studio.accountActive.length > studio.active.length" class="account-queue-indicator">В аккаунте ещё {{ studio.accountActive.length - studio.active.length }} задач в других чатах</small></div><div class="queue-actions"><button type="button" class="text-button" @click="studio.toggleQueue">{{ studio.queue.paused ? 'Продолжить' : 'Пауза' }}</button><button type="button" class="text-button danger" :disabled="!removableItems.length" @click="clearAll">Очистить всё</button></div></div>
    <div v-if="studio.active.length" class="queue-list"><div v-for="item in studio.active" :key="item.id" class="queue-row"><button type="button" class="queue-item" :class="{ selected: studio.selectedId === item.id, optimistic: item.optimistic }" :data-task-id="item.id" @click="studio.select(item.id)"><span class="queue-status-dot"></span><span><strong>{{ item.modelName || item.modelId || 'Генерация' }}</strong><small>{{ statusLabel(item) }} · {{ item.input?.prompt || 'Без промпта' }}</small></span><span class="queue-arrow">›</span></button><button v-if="canRemove(item)" type="button" class="queue-remove" aria-label="Удалить из очереди" title="Удалить из очереди" @click="removeItem(item)">×</button></div></div>
    <p v-else class="empty-state">Очередь свободна. Новая задача появится здесь после запуска.</p>
    <p v-if="studio.queue.error" class="form-error">{{ studio.queue.error }}</p>
  </section>
</template>
