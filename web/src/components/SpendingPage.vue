<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { getGenerationJournal, getSpending } from '../api/client';
import { useI18n } from '../i18n';
import type { GenerationJournalItem, SpendingCategory, SpendingItem, SpendingPageData } from '../types';

const props = defineProps<{ refreshKey: number; availableRecordIds: Set<string> }>();
const emit = defineEmits<{ result: [recordId: string] }>();
const { t, formatDate, formatNumber } = useI18n();
const days = ref<7 | 30 | 90 | null>(30);
const fromDate = ref('');
const toDate = ref('');
const appliedRange = ref<{ from: string; to: string } | null>(null);
const rangeError = ref('');
const category = ref<SpendingCategory>('all');
const data = ref<SpendingPageData | null>(null);
const items = ref<SpendingItem[]>([]);
const loading = ref(false);
const loadingMore = ref(false);
const error = ref('');
const journalProvider = ref<'all' | 'kie' | 'routerai' | 'codex'>('all');
const journalItems = ref<GenerationJournalItem[]>([]);
const journalNextOffset = ref<number | null>(null);
const journalSummary = ref<{ generations: number; sendAttempts: number } | null>(null);
const journalLoading = ref(false);
const journalError = ref('');
let journalRequestId = 0;
let requestId = 0;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let lastRefreshAt = 0;
const categories: SpendingCategory[] = ['all', 'image', 'video', 'text', 'audio', 'other'];

function credits(units: number) { return formatNumber(units / 1000, { maximumFractionDigits: 3 }); }
function categoryLabel(value: SpendingCategory) { return t(`spending.category.${value}` as 'spending.category.all'); }
function date(value: string) { return formatDate(value, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
function spendingFilter() {
  return { ...(appliedRange.value || { days: days.value || 30 }), category: category.value };
}
function selectDays(value: 7 | 30 | 90) {
  rangeError.value = '';
  appliedRange.value = null;
  days.value = value;
}
function applyRange() {
  const from = fromDate.value ? new Date(`${fromDate.value}T00:00:00`) : null;
  const end = toDate.value ? new Date(`${toDate.value}T00:00:00`) : null;
  if (!from || !end || !Number.isFinite(from.getTime()) || !Number.isFinite(end.getTime()) || from > end || from.getTime() > Date.now()) {
    rangeError.value = t('spending.rangeError');
    return;
  }
  rangeError.value = '';
  end.setDate(end.getDate() + 1);
  appliedRange.value = { from: from.toISOString(), to: end.toISOString() };
  days.value = null;
}
function eventLabel(event: string) {
  const known = ['created', 'send_start', 'submitting', 'accepted', 'success', 'fail', 'unknown', 'removed'];
  return known.includes(event) ? t(`journal.event.${event}` as 'journal.event.created') : event;
}
async function loadJournal(more = false) {
  const current = ++journalRequestId;
  const offset = more ? journalNextOffset.value : 0;
  if (offset === null) return;
  journalLoading.value = true;
  journalError.value = '';
  try {
    const page = await getGenerationJournal({ provider: journalProvider.value, offset });
    if (current !== journalRequestId) return;
    journalItems.value = more ? [...journalItems.value, ...page.items] : page.items;
    journalNextOffset.value = page.nextOffset;
    journalSummary.value = page.summary;
  } catch (cause) {
    if (current === journalRequestId) journalError.value = cause instanceof Error ? cause.message : t('journal.error');
  } finally { if (current === journalRequestId) journalLoading.value = false; }
}

async function load(reset = false) {
  const current = ++requestId;
  if (reset || !data.value) {
    loading.value = true;
    loadingMore.value = false;
    data.value = null;
    items.value = [];
  }
  error.value = '';
  try {
    const result = await getSpending(spendingFilter());
    if (current !== requestId) return;
    if (!reset && data.value) {
      const previous = data.value;
      const firstPageIds = new Set(result.items.map(item => item.id));
      const since = Date.parse(result.since);
      items.value = [...result.items, ...items.value.filter(item => !firstPageIds.has(item.id) && Date.parse(item.createdAt) >= since)];
      data.value = { ...result, nextCursor: previous.nextCursor ?? result.nextCursor };
    } else {
      data.value = result;
      items.value = result.items;
    }
  } catch (cause) {
    if (current === requestId) error.value = cause instanceof Error ? cause.message : t('spending.error');
  } finally {
    if (current === requestId) loading.value = false;
  }
}
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    lastRefreshAt = Date.now();
    void load();
    void loadJournal();
  }, Math.max(0, 2000 - (Date.now() - lastRefreshAt)));
}
async function loadMore() {
  if (!data.value?.nextCursor || loadingMore.value) return;
  const current = requestId;
  loadingMore.value = true;
  error.value = '';
  try {
    const result = await getSpending({ ...spendingFilter(), asOf: data.value.asOf, cursor: data.value.nextCursor });
    if (current !== requestId) return;
    const knownIds = new Set(items.value.map(item => item.id));
    items.value = [...items.value, ...result.items.filter(item => !knownIds.has(item.id))];
    data.value = result;
  } catch (cause) {
    if (current === requestId) error.value = cause instanceof Error ? cause.message : t('spending.error');
  } finally { loadingMore.value = false; }
}

watch([days, category, appliedRange], () => { void load(true); });
watch(journalProvider, () => { void loadJournal(); });
watch(() => props.refreshKey, scheduleRefresh);
onMounted(() => { void load(true); void loadJournal(); });
onBeforeUnmount(() => { if (refreshTimer) clearTimeout(refreshTimer); });
</script>

<template>
  <section class="spending-page" aria-labelledby="spending-title">
    <header class="spending-header"><div><span class="eyebrow">{{ t('spending.eyebrow') }}</span><h2 id="spending-title">{{ t('spending.title') }}</h2><p>{{ t('spending.lead') }}</p></div></header>
    <div class="spending-filters">
      <div class="spending-filter-group" :aria-label="t('spending.period')">
        <button v-for="period in [7, 30, 90] as const" :key="period" type="button" :class="{ active: days === period }" :aria-pressed="days === period" @click="selectDays(period)">{{ t(`spending.days.${period}` as 'spending.days.7') }}</button>
        <label class="spending-date-field">{{ t('spending.from') }} <input v-model="fromDate" type="date" :max="toDate || undefined"></label>
        <label class="spending-date-field">{{ t('spending.to') }} <input v-model="toDate" type="date" :min="fromDate || undefined"></label>
        <button type="button" :class="{ active: appliedRange }" @click="applyRange">{{ t('spending.apply') }}</button>
      </div>
      <div class="spending-filter-group spending-categories" :aria-label="t('spending.category')">
        <button v-for="option in categories" :key="option" type="button" :class="{ active: category === option }" :aria-pressed="category === option" @click="category = option">{{ categoryLabel(option) }}</button>
      </div>
    </div>
    <p v-if="rangeError" class="spending-error" role="alert">{{ rangeError }}</p>
    <div class="spending-cards spending-summary-cards" aria-live="polite">
      <article><span>{{ days === null ? t('spending.spentRange') : t('spending.spent', { days }) }}</span><strong>{{ data ? credits(data.summary.spentUnits) : '—' }}</strong><small>{{ t('spending.credits') }}</small></article>
      <article><span>{{ t('spending.top') }}</span><strong>{{ data?.summary.topCategory ? categoryLabel(data.summary.topCategory) : '—' }}</strong></article>
      <article><span>{{ t('spending.released') }}</span><strong class="spending-positive">{{ data ? `+${credits(data.summary.releasedUnits)}` : '—' }}</strong><small>{{ t('spending.credits') }}</small></article>
      <article><span>{{ t('spending.generated') }}</span><strong>{{ data ? data.summary.contentCount : '—' }}</strong></article>
    </div>
    <div class="spending-list-head"><h3>{{ t('spending.operations') }}</h3><span>{{ t('spending.reserveHint') }}</span></div>
    <p v-if="error" class="spending-error" role="alert">{{ error }} <button type="button" @click="load(true)">{{ t('common.retry') }}</button></p>
    <p v-if="loading" class="spending-state" role="status">{{ t('common.loading') }}</p>
    <p v-else-if="!items.length && !error" class="spending-state">{{ t('spending.empty') }}</p>
    <ol v-else class="spending-list">
      <li v-for="item in items" :key="item.id"><div class="spending-operation"><span :class="{ released: item.kind === 'release' }">{{ item.kind === 'capture' ? '−' : '+' }}</span><div><strong>{{ item.kind === 'capture' ? t('spending.charge') : t('spending.release') }} · {{ item.modelName || categoryLabel(item.category) }}</strong><small>{{ categoryLabel(item.category) }} · {{ date(item.createdAt) }}<template v-if="item.kind === 'capture'"> · {{ t('spending.files', { count: item.contentCount }) }}</template></small></div></div><div class="spending-operation-end"><strong :class="{ 'spending-positive': item.kind === 'release' }">{{ item.kind === 'capture' ? '−' : '+' }}{{ credits(item.amountUnits) }} {{ t('common.creditsShort') }}</strong><button v-if="item.recordId && availableRecordIds.has(item.recordId)" type="button" @click="emit('result', item.recordId)">{{ t('spending.openResult') }}</button></div></li>
    </ol>
    <button v-if="data?.nextCursor" class="spending-more" type="button" :disabled="loadingMore" @click="loadMore">{{ loadingMore ? t('common.loading') : t('spending.more') }}</button>
    <div class="spending-list-head"><div><h3>{{ t('journal.title') }}</h3><span>{{ t('journal.lead') }}</span></div></div>
    <div class="spending-filter-group" :aria-label="t('journal.title')">
      <button v-for="provider in ['all', 'kie', 'routerai', 'codex'] as const" :key="provider" type="button" :class="{ active: journalProvider === provider }" :aria-pressed="journalProvider === provider" @click="journalProvider = provider">{{ t(`journal.provider.${provider}` as 'journal.provider.all') }}</button>
    </div>
    <div v-if="journalSummary" class="spending-cards"><article><span>{{ t('journal.generations') }}</span><strong>{{ journalSummary.generations }}</strong></article><article><span>{{ t('journal.sendAttempts') }}</span><strong>{{ journalSummary.sendAttempts }}</strong></article></div>
    <p v-if="journalError" class="spending-error" role="alert">{{ journalError }} <button type="button" @click="loadJournal()">{{ t('common.retry') }}</button></p>
    <p v-if="journalLoading && !journalItems.length" class="spending-state" role="status">{{ t('common.loading') }}</p>
    <p v-else-if="!journalItems.length && !journalError" class="spending-state">{{ t('journal.empty') }}</p>
    <ol v-else class="spending-list">
      <li v-for="item in journalItems" :key="item.id"><div class="spending-operation"><div><strong>{{ t(`journal.provider.${item.provider}` as 'journal.provider.kie') }} · {{ item.model || '—' }}</strong><small>{{ eventLabel(item.event) }} · {{ date(item.createdAt) }} · {{ item.requestId || '—' }}</small></div></div><div class="spending-operation-end"><strong v-if="item.quotedCredits !== null">{{ formatNumber(item.quotedCredits, { maximumFractionDigits: 3 }) }} {{ t('common.creditsShort') }}</strong></div></li>
    </ol>
    <button v-if="journalNextOffset !== null" class="spending-more" type="button" :disabled="journalLoading" @click="loadJournal(true)">{{ journalLoading ? t('common.loading') : t('spending.more') }}</button>
  </section>
</template>
