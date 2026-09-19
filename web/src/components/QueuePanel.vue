<script setup lang="ts">
import { useStudioStore } from '../stores/studio';

const studio = useStudioStore();
const labels: Record<string, string> = { queued: 'В очереди', preparing: 'Подготовка', submitting: 'Отправка', waiting: 'Ожидание', queuing: 'Очередь провайдера', generating: 'Генерация', running: 'Генерация', unknown: 'Статус уточняется', success: 'Готово', fail: 'Ошибка', blocked: 'Требуется исправление', cancelled: 'Отменена', unconfirmed: 'Нужна сверка' };
</script>

<template>
  <section class="queue-card">
    <div class="panel-heading"><div><span class="eyebrow">ОЧЕРЕДЬ ЧАТА</span><h2>{{ studio.active.length ? `${studio.active.length} активных задач` : 'Нет активных задач' }}</h2><small v-if="studio.accountActive.length > studio.active.length" class="account-queue-indicator">В аккаунте ещё {{ studio.accountActive.length - studio.active.length }} задач в других чатах</small></div><div class="queue-actions"><button type="button" class="text-button" @click="studio.toggleQueue">{{ studio.queue.paused ? 'Продолжить' : 'Пауза' }}</button><button type="button" class="text-button danger" :disabled="!studio.accountActive.length" @click="studio.clearWaiting">Очистить ожидающие</button></div></div>
    <div v-if="studio.active.length" class="queue-list"><div v-for="item in studio.active" :key="item.id" class="queue-row"><button type="button" class="queue-item" :class="{ selected: studio.selectedId === item.id }" @click="studio.select(item.id)"><span class="queue-status-dot"></span><span><strong>{{ item.modelName || item.modelId || 'Генерация' }}</strong><small>{{ labels[item.state] || item.state }} · {{ item.input?.prompt || 'Без промпта' }}</small></span><span class="queue-arrow">›</span></button><button v-if="item.state === 'queued'" type="button" class="queue-remove" aria-label="Убрать из очереди" @click="studio.remove(item.id)">×</button></div></div>
    <p v-else class="empty-state">Очередь свободна. Новая задача появится здесь после запуска.</p>
    <p v-if="studio.queue.error" class="form-error">{{ studio.queue.error }}</p>
  </section>
</template>
