<script setup lang="ts">
import { computed } from 'vue';
import { useStudioStore } from '../stores/studio';
import type { GenerationRecord } from '../types';
import { resultModelLabel } from '../domain/result-presentation';
import { useI18n, type TranslationKey } from '../i18n';

const studio = useStudioStore();
const { t, tp } = useI18n();
const statusKey = (state: string): TranslationKey | null => state === 'running' ? 'queue.status.generating' : ({
  queued: 'queue.status.queued', preparing: 'queue.status.preparing', submitting: 'queue.status.submitting', waiting: 'queue.status.waiting',
  queuing: 'queue.status.queuing', generating: 'queue.status.generating', unknown: 'queue.status.unknown', success: 'queue.status.success',
  fail: 'queue.status.fail', blocked: 'queue.status.blocked', cancelled: 'queue.status.cancelled', unconfirmed: 'queue.status.unconfirmed',
} as Record<string, TranslationKey>)[state] || null;
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
  const warning = studio.isAdmin
    ? t('queue.removeWarningAdmin')
    : t('queue.removeWarning');
  if (sentToKie(item) && !confirm(warning)) return;
  await studio.remove(item.id);
}
async function clearAll() {
  const warning = studio.isAdmin
    ? t('queue.clearWarningAdmin')
    : t('queue.clearWarning');
  if (removableItems.value.some(sentToKie) && !confirm(warning)) return;
  await studio.clearWaiting();
}
function statusLabel(item: { providerId: string; state: string; optimistic?: boolean }) {
  if (item.optimistic) return t('queue.status.optimistic');
  if (!studio.isAdmin) {
    const key = ({ submitting: 'queue.status.publicSubmitting', waiting: 'queue.status.publicWaiting', queuing: 'queue.status.publicQueuing', generating: 'queue.status.generating', running: 'queue.status.generating' } as Record<string, TranslationKey>)[item.state] || statusKey(item.state);
    return key ? t(key) : item.state;
  }
  if (['media', 'kie'].includes(item.providerId)) {
    const key = ({ submitting: 'queue.status.kieSubmitting', waiting: 'queue.status.kieWaiting', queuing: 'queue.status.kieQueuing', generating: 'queue.status.kieWaiting' } as Record<string, TranslationKey>)[item.state] || statusKey(item.state);
    return key ? t(key) : item.state;
  }
  const key = statusKey(item.state);
  return key ? t(key) : item.state;
}
const queueError = computed(() => studio.queue.error ? (studio.isAdmin ? studio.queue.error : t('queue.unavailable')) : '');
</script>

<template>
  <section class="queue-card">
    <div class="panel-heading"><div><span class="eyebrow">{{ t('queue.eyebrow') }}</span><h2>{{ studio.active.length ? tp('queue.active', studio.active.length) : t('queue.noneActive') }}</h2><small v-if="studio.accountActive.length > studio.active.length" class="account-queue-indicator">{{ t('queue.otherChats', { count: studio.accountActive.length - studio.active.length }) }}</small></div><div class="queue-actions"><button type="button" class="text-button" @click="studio.toggleQueue">{{ studio.queue.paused ? t('queue.resume') : t('queue.pause') }}</button><button type="button" class="text-button danger" :disabled="!removableItems.length" @click="clearAll">{{ t('queue.clear') }}</button></div></div>
    <div v-if="studio.active.length" class="queue-list"><div v-for="item in studio.active" :key="item.id" class="queue-row"><button type="button" class="queue-item" :class="{ selected: studio.selectedId === item.id, optimistic: item.optimistic }" :data-task-id="item.id" @click="studio.select(item.id)"><span class="queue-status-dot"></span><span><strong>{{ resultModelLabel(item, studio.isAdmin) }}</strong><small>{{ statusLabel(item) }} · {{ item.input?.prompt || t('common.noPrompt') }}</small></span><span class="queue-arrow">›</span></button><button v-if="canRemove(item)" type="button" class="queue-remove" :aria-label="t('queue.remove')" :title="t('queue.remove')" @click="removeItem(item)">×</button></div></div>
    <p v-else class="empty-state">{{ t('queue.empty') }}</p>
    <p v-if="queueError" class="form-error">{{ queueError }}</p>
  </section>
</template>
