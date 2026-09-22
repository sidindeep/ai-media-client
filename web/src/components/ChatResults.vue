<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useStudioStore } from '../stores/studio';
import type { GenerationRecord } from '../types';
import { formatCreditCost } from '../domain/credits';
import { resultError, resultModelLabel } from '../domain/result-presentation';
import { useI18n } from '../i18n';
import { generationDuration, generationStateLabel, reasoningEffortLabel } from '../i18n/presentation';

const emit = defineEmits<{ select: [id: string] }>();
const studio = useStudioStore();
const { formatDate, formatNumber, t } = useI18n();
const now = ref(Date.now());
const scrollBox = ref<HTMLElement | null>(null);
const showLatestButton = ref(false);
let timer: ReturnType<typeof setInterval> | undefined;
let saveFrame: number | undefined;
let restoreRevision = 0;
let restoring = false;
let initialScrollRestored = false;
let displayedChatId = studio.activeChatId;

type SavedScrollPosition = { top: number; atBottom: boolean; updatedAt: number };
const BOTTOM_THRESHOLD = 32;
const MAX_SAVED_CHATS = 100;

const activeStates = new Set(['queued', 'preparing', 'submitting', 'waiting', 'queuing', 'generating', 'running']);

const records = computed(() => [...studio.visibleRecords].sort((left, right) => {
  const leftTime = left.createdAt ? Date.parse(left.createdAt) : 0;
  const rightTime = right.createdAt ? Date.parse(right.createdAt) : 0;
  return leftTime - rightTime;
}));

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
  return record.providerName || (record.providerId === 'codex' ? 'Codex' : record.providerId === 'media' ? 'Kie.ai' : record.providerId);
}
function status(record: GenerationRecord) {
  if (studio.isAdmin) return `${provider(record)} · ${generationStateLabel(record.state)}`;
  return generationStateLabel(record.state);
}
function select(record: GenerationRecord) { emit('select', record.id); }

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
  if (!element) return null;
  const bottomDistance = Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop);
  return { top: Math.max(0, element.scrollTop), atBottom: bottomDistance <= BOTTOM_THRESHOLD };
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
  if (!element || restoring || studio.activeChatId !== displayedChatId) return;
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
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  if (revision !== restoreRevision || studio.activeChatId !== chatId || !scrollBox.value) return;
  const saved = savedScrollPositions()[chatId];
  const maximum = Math.max(0, scrollBox.value.scrollHeight - scrollBox.value.clientHeight);
  scrollBox.value.scrollTop = saved && !saved.atBottom ? Math.min(saved.top, maximum) : maximum;
  displayedChatId = chatId;
  restoring = false;
  updateLatestButton();
  saveScrollPosition(chatId);
}

function keepLatestAfterMediaLoad() {
  if (restoring || studio.activeChatId !== displayedChatId) return;
  const saved = savedScrollPositions()[studio.activeChatId];
  if (!saved || saved.atBottom) setLatestPosition();
  else updateLatestButton();
}

async function revealSelected() {
  await nextTick();
  if (restoring) return;
  document.querySelector<HTMLElement>(`.chat-result-item[data-record-id="${CSS.escape(studio.selectedId || '')}"]`)
    ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

watch(() => studio.selectedId, () => {
  // Startup selects a default result while the saved chat position is being
  // restored. Revealing that result here would override the restored scroll.
  if (initialScrollRestored) void revealSelected();
});
watch(() => studio.activeChatId, (chatId, previousChatId) => {
  if (previousChatId) saveScrollPosition(previousChatId);
  displayedChatId = chatId;
  void restoreScrollPosition(chatId);
}, { flush: 'sync' });
watch(() => records.value.map(record => `${record.id}:${record.state}:${record.output?.length || 0}:${record.resultJson?.length || 0}`).join('|'), async () => {
  if (restoring) return;
  const chatId = studio.activeChatId;
  const followLatest = scrollMetrics()?.atBottom ?? true;
  await nextTick();
  if (chatId !== studio.activeChatId || restoring) return;
  if (followLatest) setLatestPosition();
  else updateLatestButton();
});
onMounted(() => {
  timer = setInterval(() => { now.value = Date.now(); }, 1000);
  void restoreScrollPosition(studio.activeChatId).then(() => { initialScrollRestored = true; });
});
onBeforeUnmount(() => {
  if (!restoring) saveScrollPosition(displayedChatId);
  if (timer) clearInterval(timer);
  if (saveFrame !== undefined) cancelAnimationFrame(saveFrame);
});
</script>

<template>
  <section class="chat-feed" :aria-label="t('generation.chatResults')">
    <div ref="scrollBox" class="chat-results" role="log" aria-live="polite" @scroll.passive="handleScroll">
      <article v-for="record in records" :key="record.id" class="chat-result-item" :class="{ selected: studio.selectedId === record.id }" :data-record-id="record.id">
        <p class="chat-prompt">{{ prompt(record) }}</p>
        <div class="chat-result-card" role="button" tabindex="0" :aria-label="t('generation.openDetails', { model: resultModelLabel(record, studio.isAdmin) })" @click="select(record)" @keydown.enter.prevent="select(record)" @keydown.space.prevent="select(record)">
          <header class="chat-result-header">
            <span class="chat-result-state" :class="`state-${record.state}`" aria-hidden="true"></span>
            <span class="chat-result-title"><strong>{{ resultModelLabel(record, studio.isAdmin) }}</strong><small>{{ status(record) }}</small></span>
            <span class="chat-result-arrow" aria-hidden="true">›</span>
          </header>
          <p class="chat-result-prompt">{{ prompt(record) }}</p>
          <div v-if="resultUrls(record).length" class="chat-result-media">
            <video v-if="record.kind === 'video'" :src="resultUrls(record)[0]" controls playsinline @loadedmetadata="keepLatestAfterMediaLoad" @click.stop></video>
            <audio v-else-if="record.kind === 'audio'" :src="resultUrls(record)[0]" controls @loadedmetadata="keepLatestAfterMediaLoad" @click.stop></audio>
            <img v-else v-for="url in resultUrls(record)" :key="url" :src="url" :alt="t('generation.resultAlt')" @load="keepLatestAfterMediaLoad" />
          </div>
          <pre v-else class="chat-result-output" :class="{ pending: activeStates.has(record.state) }">{{ previewText(record) }}</pre>
          <footer class="chat-result-meta"><span v-for="item in meta(record)" :key="item">{{ item }}</span></footer>
        </div>
      </article>
    </div>
    <Transition name="chat-latest">
      <button v-if="showLatestButton" type="button" class="chat-latest-button" :aria-label="t('generation.latest')" :title="t('generation.latest')" @click="scrollToLatest">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v14m-6-6 6 6 6-6" /></svg>
      </button>
    </Transition>
  </section>
</template>
