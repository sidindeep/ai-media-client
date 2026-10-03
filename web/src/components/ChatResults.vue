<script setup lang="ts">
import AppIcon from "./AppIcon.vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useStudioStore } from '../stores/studio';
import type { GenerationRecord } from '../types';
import { formatCreditCost } from '../domain/credits';
import { generationProviderLabel } from '../domain/provider-label';
import { resultError, resultModelLabel } from '../domain/result-presentation';
import { useI18n } from '../i18n';
import { generationDuration, generationStateLabel, reasoningEffortLabel } from '../i18n/presentation';
import ExpandableResultImage from './ExpandableResultImage.vue';
import { resultDownloadUrl } from '../domain/result-download';

const emit = defineEmits<{ select: [id: string] }>();
const studio = useStudioStore();
const { formatDate, formatNumber, t } = useI18n();
const now = ref(Date.now());
const scrollBox = ref<HTMLElement | null>(null);
const showLatestButton = ref(false);
const errorDialog = ref<HTMLDialogElement | null>(null);
const errorRecord = ref<GenerationRecord | null>(null);
let errorTrigger: HTMLElement | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
let resizeObserver: ResizeObserver | undefined;
let saveFrame: number | undefined;
let restoreRevision = 0;
let restoring = false;
let initialScrollRestored = false;
let displayedChatId = studio.activeChatId;

type SavedScrollPosition = { top: number; atBottom: boolean; updatedAt: number; anchorId?: string; anchorOffset?: number };
const BOTTOM_THRESHOLD = 32;
const MAX_SAVED_CHATS = 100;

const activeStates = new Set(['queued', 'preparing', 'submitting', 'waiting', 'queuing', 'generating', 'running']);

const records = computed(() => [...studio.visibleRecords].sort((left, right) => {
  const leftTime = left.createdAt ? Date.parse(left.createdAt) : 0;
  const rightTime = right.createdAt ? Date.parse(right.createdAt) : 0;
  return leftTime - rightTime;
}));
const knownRecordCount = computed(() => studio.activeChatId === 'system:recent'
  ? studio.systemChat.materialCount
  : studio.chats.find(chat => chat.id === studio.activeChatId)?.materialCount || 0);
const hasOlderRecords = computed(() => Boolean(studio.chatHistoryNext[studio.activeChatId]));
const needsFirstPage = computed(() => knownRecordCount.value > 0 && !studio.chatHistoryLoaded[studio.activeChatId]);
function loadChatHistory(older = false) { void studio.loadChatHistory(older).catch(() => {}); }

function prompt(record: GenerationRecord) {
  return typeof record.input?.prompt === 'string' && record.input.prompt.trim() ? record.input.prompt : t('common.noPrompt');
}
function formatCount(value: number | null | undefined) { return value == null ? '' : formatNumber(value); }
function timestamp(value?: string) {
  return value ? formatDate(value, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
}
function duration(record: GenerationRecord) {
  let milliseconds = record.generationDurationMs;
  if (milliseconds == null && activeStates.has(record.state)) {
    const started = Date.parse(record.generationStartedAt || record.createdAt || '');
    if (Number.isFinite(started)) milliseconds = now.value - started;
  }
  return generationDuration(milliseconds);
}
function totalTokens(record: GenerationRecord) { return record.usage?.total_tokens ?? record.usage?.totalTokens; }
function meta(record: GenerationRecord) {
  const effort = typeof record.input?.effort === 'string' ? reasoningEffortLabel(record.input.effort) : '';
  const speed = record.input?.speed === 'fast' ? 'Fast' : record.input?.speed === 'standard' ? t('generation.speed.standard') : '';
  return [
    timestamp(record.createdAt), duration(record),
    record.nativeQuote?.credits != null ? `${formatCreditCost(record.nativeQuote.credits)} ${t('common.creditsShort')}` : '',
    record.providerId === 'apimart' && record.apimartTariffCost
      ? `${t(record.apimartTariffCost.confirmed ? 'apimart.admin.actualCost' : 'apimart.admin.tariffCost')} ${record.apimartTariffCost.confirmed ? '' : '≈ '}${formatNumber(record.apimartTariffCost.nativeCredits, { maximumFractionDigits: 8 })} ${t('common.creditsShort')} ($${formatNumber(record.apimartTariffCost.amountUsd, { maximumFractionDigits: 8 })})` : '',
    studio.isAdmin && totalTokens(record) != null ? t('generation.tokensShort', { count: formatCount(totalTokens(record)) }) : '', effort, speed,
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
  if (record.error) return resultError(record, studio.isAdmin);
  return activeStates.has(record.state) ? t('generation.resultPending') : generationStateLabel(record.state);
}
function provider(record: GenerationRecord) {
  return generationProviderLabel(record, studio.catalog);
}
function status(record: GenerationRecord) {
  if (studio.isAdmin) return `${provider(record)} · ${generationStateLabel(record.state)}`;
  return generationStateLabel(record.state);
}
function select(record: GenerationRecord) { emit('select', record.id); }
function fullError(record: GenerationRecord) {
  const summary = resultError(record, studio.isAdmin);
  if (!studio.isAdmin) return summary;
  const code = record.errorInfo?.providerCode;
  const message = record.errorInfo?.providerMessage?.trim();
  return [summary,
    code != null && !summary.includes(String(code)) ? `${t('generation.errorCode')}: ${code}` : '',
    message && !summary.includes(message) ? `${t('generation.providerError')}: ${message}` : '',
  ].filter(Boolean).join('\n\n');
}
async function openErrorDetails(record: GenerationRecord, event: MouseEvent) {
  errorTrigger = event.currentTarget as HTMLElement;
  errorRecord.value = record;
  await nextTick();
  errorDialog.value?.showModal();
}
function closeErrorDetails() { errorDialog.value?.close(); }
function onErrorDialogClose() {
  errorRecord.value = null;
  errorTrigger?.focus();
  errorTrigger = null;
}

function scrollStorageKey() {
  const accountId = document.querySelector<HTMLMetaElement>('meta[name="account-id"]')?.content || 'local';
  return `ai-media-chat-scroll:${accountId}`;
}

function savedScrollPositions(): Record<string, SavedScrollPosition> {
  try {
    const value = JSON.parse(localStorage.getItem(scrollStorageKey()) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function scrollMetrics() {
  const element = scrollBox.value;
  if (!element || !element.clientHeight || !element.getClientRects().length) return null;
  const bottomDistance = Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop);
  const boxTop = element.getBoundingClientRect().top;
  const anchor = Array.from(element.querySelectorAll<HTMLElement>('.chat-result-item'))
    .find(item => item.getBoundingClientRect().bottom > boxTop + 1);
  return {
    top: Math.max(0, element.scrollTop),
    atBottom: bottomDistance <= BOTTOM_THRESHOLD,
    anchorId: anchor?.dataset.recordId,
    anchorOffset: anchor ? anchor.getBoundingClientRect().top - boxTop : undefined,
  };
}

function updateLatestButton() {
  const metrics = scrollMetrics();
  showLatestButton.value = Boolean(metrics && !metrics.atBottom);
}

function saveScrollPosition(chatId = displayedChatId, metrics = scrollMetrics()) {
  if (!chatId || !metrics) return;
  try {
    const positions = savedScrollPositions();
    delete positions[chatId];
    positions[chatId] = { ...metrics, updatedAt: Date.now() };
    const trimmed = Object.fromEntries(Object.entries(positions)
      .sort(([, left], [, right]) => left.updatedAt - right.updatedAt)
      .slice(-MAX_SAVED_CHATS));
    localStorage.setItem(scrollStorageKey(), JSON.stringify(trimmed));
  } catch { /* Scrolling still works when browser storage is unavailable. */ }
}

function scheduleScrollSave() {
  if (saveFrame !== undefined) cancelAnimationFrame(saveFrame);
  const chatId = displayedChatId;
  const metrics = scrollMetrics();
  saveFrame = requestAnimationFrame(() => {
    saveFrame = undefined;
    saveScrollPosition(chatId, metrics);
  });
}

function handleScroll() {
  updateLatestButton();
  if (!restoring) scheduleScrollSave();
}

function setLatestPosition(behavior: ScrollBehavior = 'auto') {
  const element = scrollBox.value;
  if (!element || !scrollMetrics() || restoring || studio.activeChatId !== displayedChatId) return;
  element.scrollTo({ top: element.scrollHeight, behavior });
  if (behavior === 'auto') {
    updateLatestButton();
    saveScrollPosition();
  }
}

function scrollToLatest() { setLatestPosition('smooth'); }

async function restoreScrollPosition(chatId: string) {
  const revision = ++restoreRevision;
  restoring = true;
  await nextTick();
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  if (revision !== restoreRevision || studio.activeChatId !== chatId || !scrollBox.value || !scrollMetrics()) return;
  const saved = savedScrollPositions()[chatId];
  const element = scrollBox.value;
  const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
  if (saved && !saved.atBottom) {
    const anchor = saved.anchorId && Array.from(element.querySelectorAll<HTMLElement>('.chat-result-item'))
      .find(item => item.dataset.recordId === saved.anchorId);
    element.scrollTop = anchor && Number.isFinite(saved.anchorOffset)
      ? Math.max(0, element.scrollTop + anchor.getBoundingClientRect().top - element.getBoundingClientRect().top - saved.anchorOffset!)
      : Math.min(saved.top, maximum);
  } else element.scrollTop = maximum;
  displayedChatId = chatId;
  restoring = false;
  initialScrollRestored = true;
  updateLatestButton();
}

async function revealSelected() {
  await nextTick();
  if (restoring || !scrollMetrics()) return;
  scrollBox.value?.querySelector<HTMLElement>(`.chat-result-item[data-record-id="${CSS.escape(studio.selectedId || '')}"]`)
    ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

watch(() => studio.selectedId, () => {
  // Startup selects a default result while the saved chat position is being
  // restored. Revealing that result here would override the restored scroll.
  if (initialScrollRestored) void revealSelected();
});
watch(() => studio.activeChatId, (chatId, previousChatId) => {
  closeErrorDetails();
  if (previousChatId && !restoring) saveScrollPosition(previousChatId);
  displayedChatId = chatId;
  initialScrollRestored = false;
  void restoreScrollPosition(chatId);
  loadChatHistory();
}, { flush: 'sync' });
watch(() => records.value.map(record => `${record.id}:${record.state}:${record.output?.length || 0}:${record.resultJson?.length || 0}`).join('|'), async () => {
  if (restoring || !initialScrollRestored) return;
  const chatId = studio.activeChatId;
  const metrics = scrollMetrics();
  if (!metrics) return;
  const followLatest = metrics.atBottom;
  await nextTick();
  if (chatId !== studio.activeChatId || restoring) return;
  if (followLatest) setLatestPosition();
  else updateLatestButton();
});
onMounted(() => {
  timer = setInterval(() => { now.value = Date.now(); }, 1000);
  resizeObserver = new ResizeObserver(() => {
    if (restoring && scrollMetrics()) void restoreScrollPosition(studio.activeChatId);
  });
  if (scrollBox.value) resizeObserver.observe(scrollBox.value);
  window.addEventListener('pagehide', handlePageHide);
  void restoreScrollPosition(studio.activeChatId);
  loadChatHistory();
});
function handlePageHide() { if (!restoring) saveScrollPosition(); }
onBeforeUnmount(() => {
  if (!restoring) saveScrollPosition(displayedChatId);
  if (timer) clearInterval(timer);
  resizeObserver?.disconnect();
  window.removeEventListener('pagehide', handlePageHide);
  if (saveFrame !== undefined) cancelAnimationFrame(saveFrame);
  restoreRevision++;
});
</script>

<template>
  <section class="chat-feed" :aria-label="t('generation.chatResults')">
    <div ref="scrollBox" class="chat-results" role="log" aria-live="polite" @scroll.passive="handleScroll">
      <div v-if="needsFirstPage || hasOlderRecords || studio.chatHistoryError" class="chat-older-records"><button type="button" class="action-button" :disabled="studio.chatHistoryLoading" @click="loadChatHistory(Boolean(studio.chatHistoryLoaded[studio.activeChatId]))">{{ studio.chatHistoryLoading ? t('history.loading') : t('history.loadMore') }}</button><p v-if="studio.chatHistoryError" role="alert">{{ t('studio.loadError') }}</p></div>
      <article v-for="record in records" :key="record.id" class="chat-result-item" :class="{ selected: studio.selectedId === record.id }" :data-record-id="record.id">
        <p class="chat-prompt">{{ prompt(record) }}</p>
        <div class="chat-result-card" @click="select(record)">
          <button type="button" class="chat-result-header" :aria-label="t('generation.openDetails', { model: resultModelLabel(record, studio.isAdmin) })" @click.stop="select(record)">
            <span class="chat-result-state" :class="`state-${record.state}`" aria-hidden="true"></span>
            <span class="chat-result-title"><strong>{{ resultModelLabel(record, studio.isAdmin) }}</strong><small>{{ status(record) }}</small></span>
            <span class="chat-result-arrow" aria-hidden="true"><AppIcon name="chevron-right" /></span>
          </button>
          <p class="chat-result-prompt">{{ prompt(record) }}</p>
          <div v-if="resultUrls(record).length" class="chat-result-media">
            <template v-if="record.kind === 'video'"><video v-for="url in resultUrls(record)" :key="url" :src="url" controls playsinline @click.stop></video></template>
            <template v-else-if="record.kind === 'audio'"><audio v-for="url in resultUrls(record)" :key="url" :src="url" controls @click.stop></audio></template>
            <ExpandableResultImage v-else v-for="(url, index) in resultUrls(record)" :key="url" :src="url"
              :download-url="resultDownloadUrl(record, index, url)" :alt="t('generation.resultAlt')" />
          </div>
          <pre v-else class="chat-result-output" :class="{ pending: activeStates.has(record.state) }">{{ previewText(record) }}</pre>
          <div v-if="record.error" class="chat-result-error-actions">
            <button type="button" class="chat-result-error-details" @click.stop="openErrorDetails(record, $event)">{{ t('generation.errorDetailsButton') }}</button>
          </div>
          <footer class="chat-result-meta"><span v-for="item in meta(record)" :key="item">{{ item }}</span></footer>
        </div>
        <div v-if="resultUrls(record).length" class="chat-result-download-row">
          <a class="chat-result-download" :href="resultDownloadUrl(record, 0, resultUrls(record)[0])" target="_blank" rel="noopener">
            <AppIcon name="download" />
            {{ t('common.download') }}
          </a>
        </div>
      </article>
    </div>
    <Transition name="chat-latest">
      <button v-if="showLatestButton" type="button" class="chat-latest-button" :aria-label="t('generation.latest')" :title="t('generation.latest')" @click="scrollToLatest">
        <AppIcon name="arrow-down" />
      </button>
    </Transition>
    <Teleport to="body">
      <dialog v-if="errorRecord" ref="errorDialog" class="chat-error-dialog" aria-labelledby="chat-error-dialog-title" @click.self="closeErrorDetails" @close="onErrorDialogClose">
        <header class="chat-error-dialog-header">
          <div><h2 id="chat-error-dialog-title">{{ t('generation.errorDetails') }}</h2><p>{{ resultModelLabel(errorRecord, studio.isAdmin) }}</p></div>
          <button type="button" class="chat-error-dialog-close" :aria-label="t('common.close')" @click="closeErrorDetails"><AppIcon name="close" /></button>
        </header>
        <div class="chat-error-dialog-content">
          <h3>{{ t('history.prompt') }}</h3>
          <pre>{{ prompt(errorRecord) }}</pre>
          <h3>{{ t('generation.errorMessage') }}</h3>
          <pre class="chat-error-dialog-message">{{ fullError(errorRecord) }}</pre>
        </div>
      </dialog>
    </Teleport>
  </section>
</template>
