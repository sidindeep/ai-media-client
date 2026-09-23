<script setup lang="ts">
import { computed } from 'vue';
import { useStudioStore } from '../stores/studio';
import type { GenerationRecord } from '../types';
import { formatCreditCost } from '../domain/credits';
import { generationProviderLabel } from '../domain/provider-label';
import { resultError, resultModelLabel } from '../domain/result-presentation';
import { useI18n } from '../i18n';
import { generationDuration, generationStateLabel, reasoningEffortLabel } from '../i18n/presentation';

const emit = defineEmits<{ select: [record: GenerationRecord]; workspace: [] }>();
const studio = useStudioStore();
const { formatDate, formatNumber, t } = useI18n();
const completedStates = new Set(['success', 'fail', 'blocked', 'unknown', 'unconfirmed', 'cancelled']);
const records = computed(() => studio.history.filter(record => completedStates.has(record.state)));
const selectedRecord = computed(() => records.value.find(record => record.id === studio.selectedId) || null);
const selectedPrompt = computed(() => {
  const prompt = selectedRecord.value?.input?.prompt;
  return typeof prompt === 'string' && prompt.trim() ? prompt : t('common.noPrompt');
});
const selectedUrls = computed(() => {
  const record = selectedRecord.value;
  if (!record) return [];
  const local = (record.localFiles || []).map(file => file.previewUrl || file.url).filter(Boolean) as string[];
  if (local.length) return local;
  try {
    const value = JSON.parse(record.resultJson || '{}');
    return Array.isArray(value.resultUrls) ? value.resultUrls.filter((url: unknown): url is string => typeof url === 'string') : [];
  } catch { return []; }
});

function formatCount(value: number | null | undefined) { return value == null ? '' : formatNumber(value); }
function formatDuration(milliseconds: number | null | undefined) {
  return generationDuration(milliseconds);
}
function timestamp(value?: string) {
  return value ? formatDate(value, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
}
function historyMeta(record: GenerationRecord) {
  const total = record.usage?.total_tokens ?? record.usage?.totalTokens;
  const effort = typeof record.input?.effort === 'string' ? reasoningEffortLabel(record.input.effort) : '';
  const speed = record.input?.speed === 'fast' ? 'Fast' : record.input?.speed === 'standard' ? t('generation.speed.standard') : '';
  return [studio.isAdmin ? generationProviderLabel(record, studio.catalog) : '', timestamp(record.createdAt), formatDuration(record.generationDurationMs), record.nativeQuote?.credits != null ? `${formatCreditCost(record.nativeQuote.credits)} ${t('common.creditsShort')}` : '', studio.isAdmin && total != null ? t('generation.tokensShort', { count: formatCount(total) }) : '', effort, speed].filter(Boolean).join(' · ');
}
function totalTokens(record: GenerationRecord) { return record.usage?.total_tokens ?? record.usage?.totalTokens; }
function creditCost(record: GenerationRecord) { return record.nativeQuote?.credits == null ? '—' : formatCreditCost(record.nativeQuote.credits); }
</script>

<template>
  <section class="history-page" aria-labelledby="history-title">
    <header class="history-page-header"><div><span class="eyebrow">{{ t('history.eyebrow') }}</span><h2 id="history-title">{{ t('history.title') }}</h2><p>{{ t('history.lead') }}</p></div><div class="history-page-actions"><span class="history-page-count">{{ records.length }}</span><button type="button" class="history-page-back" @click="emit('workspace')">{{ t('history.back') }}</button></div></header>
    <div class="history-page-body">
      <div class="result-history history-page-list"><div class="history-heading"><strong>{{ t('history.completed') }}</strong><span>{{ records.length }}</span></div><button v-for="item in records" :key="item.id" type="button" class="history-item" :class="{ selected: studio.selectedId === item.id }" :data-record-id="item.id" @click="emit('select', item)"><span>{{ item.state === 'success' ? '●' : '○' }}</span><span><strong>{{ resultModelLabel(item, studio.isAdmin) }}</strong><small>{{ item.input?.prompt || (item.error ? resultError(item, studio.isAdmin) : t('common.noPrompt')) }}</small><small class="history-item-meta">{{ historyMeta(item) }}</small></span><span class="history-item-arrow" aria-hidden="true">›</span></button><p v-if="!records.length" class="empty-state">{{ t('history.empty') }}</p></div>
      <aside class="history-detail" aria-live="polite">
        <div v-if="selectedRecord" class="history-detail-content" :data-record-id="selectedRecord.id">
          <header class="history-detail-header"><div><span class="eyebrow">{{ t('history.recordContent') }}</span><h3>{{ resultModelLabel(selectedRecord, studio.isAdmin) }}</h3></div><span class="history-detail-status" :class="`is-${selectedRecord.state}`">{{ generationStateLabel(selectedRecord.state) }}</span></header>
          <div class="history-detail-field"><span>{{ t('history.prompt') }}</span><p>{{ selectedPrompt }}</p></div>
          <div class="history-detail-field history-detail-result"><span>{{ t('history.result') }}</span>
            <div v-if="selectedUrls.length" class="history-detail-media">
              <video v-if="selectedRecord.kind === 'video'" :src="selectedUrls[0]" controls playsinline></video>
              <audio v-else-if="selectedRecord.kind === 'audio'" :src="selectedUrls[0]" controls></audio>
              <template v-else><img v-for="url in selectedUrls" :key="url" :src="url" :alt="t('generation.resultAlt')"></template>
            </div>
            <pre v-if="selectedRecord.output" class="history-detail-output">{{ selectedRecord.output }}</pre>
            <p v-else-if="selectedRecord.error" class="history-detail-error">{{ resultError(selectedRecord, studio.isAdmin) }}</p>
            <p v-else-if="!selectedUrls.length" class="history-detail-empty">{{ t('history.noPreview') }}</p>
          </div>
          <dl class="history-detail-facts"><div v-if="studio.isAdmin"><dt>{{ t('history.provider') }}</dt><dd>{{ generationProviderLabel(selectedRecord, studio.catalog) }}</dd></div><div><dt>{{ t('history.created') }}</dt><dd>{{ timestamp(selectedRecord.createdAt) || '—' }}</dd></div><div><dt>{{ t('history.time') }}</dt><dd>{{ formatDuration(selectedRecord.generationDurationMs) || '—' }}</dd></div><div><dt>{{ t('history.cost') }}</dt><dd>{{ creditCost(selectedRecord) }}</dd></div><div v-if="studio.isAdmin"><dt>{{ t('history.tokens') }}</dt><dd>{{ formatCount(totalTokens(selectedRecord)) || '—' }}</dd></div></dl>
          <a v-if="selectedUrls[0]" class="action-button history-detail-download" :href="selectedRecord.localFiles?.[0]?.url || selectedUrls[0]" download>{{ t('history.download') }}</a>
        </div>
        <div v-else class="history-detail-placeholder"><span aria-hidden="true">→</span><strong>{{ t('history.select') }}</strong><p>{{ t('history.selectHint') }}</p></div>
      </aside>
    </div>
  </section>
</template>
