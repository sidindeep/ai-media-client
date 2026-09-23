<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { getSpending } from '../api/client';
import { useI18n } from '../i18n';
import type { SpendingCategory, SpendingItem, SpendingPageData } from '../types';

const props = defineProps<{ refreshKey: number; availableRecordIds: Set<string> }>();
const emit = defineEmits<{ result: [recordId: string] }>();
const { t, formatDate, formatNumber } = useI18n();
const days = ref<7 | 30 | 90>(30);
const category = ref<SpendingCategory>('all');
const data = ref<SpendingPageData | null>(null);
const items = ref<SpendingItem[]>([]);
const loading = ref(false);
const loadingMore = ref(false);
const error = ref('');
let requestId = 0;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let lastRefreshAt = 0;
const categories: SpendingCategory[] = ['all', 'image', 'video', 'text', 'audio', 'other'];

function credits(units: number) { return formatNumber(units / 1000, { maximumFractionDigits: 3 }); }
function categoryLabel(value: SpendingCategory) { return t(`spending.category.${value}` as 'spending.category.all'); }
function date(value: string) { return formatDate(value, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }

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
    const result = await getSpending({ days: days.value, category: category.value });
    if (current !== requestId) return;
    if (!reset && data.value) {
      const previous = data.value;
      const firstPageIds = new Set(result.items.map(item => item.id));
      const since = Date.parse(result.asOf) - result.days * 86400000;
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
  }, Math.max(0, 2000 - (Date.now() - lastRefreshAt)));
}
async function loadMore() {
  if (!data.value?.nextCursor || loadingMore.value) return;
  const current = requestId;
  loadingMore.value = true;
  error.value = '';
  try {
    const result = await getSpending({ days: days.value, category: category.value, asOf: data.value.asOf, cursor: data.value.nextCursor });
    if (current !== requestId) return;
    const knownIds = new Set(items.value.map(item => item.id));
    items.value = [...items.value, ...result.items.filter(item => !knownIds.has(item.id))];
    data.value = result;
  } catch (cause) {
    if (current === requestId) error.value = cause instanceof Error ? cause.message : t('spending.error');
  } finally { loadingMore.value = false; }
}

watch([days, category], () => { void load(true); });
watch(() => props.refreshKey, scheduleRefresh);
onMounted(() => { void load(true); });
onBeforeUnmount(() => { if (refreshTimer) clearTimeout(refreshTimer); });
</script>

<template>
  <section class="spending-page" aria-labelledby="spending-title">
    <header class="spending-header"><div><span class="eyebrow">{{ t('spending.eyebrow') }}</span><h2 id="spending-title">{{ t('spending.title') }}</h2><p>{{ t('spending.lead') }}</p></div></header>
    <div class="spending-filters">
      <div class="spending-filter-group" :aria-label="t('spending.period')">
        <button v-for="period in [7, 30, 90] as const" :key="period" type="button" :class="{ active: days === period }" :aria-pressed="days === period" @click="days = period">{{ t(`spending.days.${period}` as 'spending.days.7') }}</button>
      </div>
      <div class="spending-filter-group spending-categories" :aria-label="t('spending.category')">
        <button v-for="option in categories" :key="option" type="button" :class="{ active: category === option }" :aria-pressed="category === option" @click="category = option">{{ categoryLabel(option) }}</button>
      </div>
    </div>
    <div class="spending-cards" aria-live="polite">
      <article><span>{{ t('spending.spent', { days }) }}</span><strong>{{ data ? credits(data.summary.spentUnits) : '—' }}</strong><small>{{ t('spending.credits') }}</small></article>
      <article><span>{{ t('spending.top') }}</span><strong>{{ data?.summary.topCategory ? categoryLabel(data.summary.topCategory) : '—' }}</strong></article>
      <article><span>{{ t('spending.released') }}</span><strong class="spending-positive">{{ data ? `+${credits(data.summary.releasedUnits)}` : '—' }}</strong><small>{{ t('spending.credits') }}</small></article>
    </div>
    <div class="spending-list-head"><h3>{{ t('spending.operations') }}</h3><span>{{ t('spending.reserveHint') }}</span></div>
    <p v-if="error" class="spending-error" role="alert">{{ error }} <button type="button" @click="load(true)">{{ t('common.retry') }}</button></p>
    <p v-if="loading" class="spending-state" role="status">{{ t('common.loading') }}</p>
    <p v-else-if="!items.length && !error" class="spending-state">{{ t('spending.empty') }}</p>
    <ol v-else class="spending-list">
      <li v-for="item in items" :key="item.id"><div class="spending-operation"><span :class="{ released: item.kind === 'release' }">{{ item.kind === 'capture' ? '−' : '+' }}</span><div><strong>{{ item.kind === 'capture' ? t('spending.charge') : t('spending.release') }} · {{ item.modelName || categoryLabel(item.category) }}</strong><small>{{ categoryLabel(item.category) }} · {{ date(item.createdAt) }}</small></div></div><div class="spending-operation-end"><strong :class="{ 'spending-positive': item.kind === 'release' }">{{ item.kind === 'capture' ? '−' : '+' }}{{ credits(item.amountUnits) }} {{ t('common.creditsShort') }}</strong><button v-if="item.recordId && availableRecordIds.has(item.recordId)" type="button" @click="emit('result', item.recordId)">{{ t('spending.openResult') }}</button></div></li>
    </ol>
    <button v-if="data?.nextCursor" class="spending-more" type="button" :disabled="loadingMore" @click="loadMore">{{ loadingMore ? t('common.loading') : t('spending.more') }}</button>
  </section>
</template>
