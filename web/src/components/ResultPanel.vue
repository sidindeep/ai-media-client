<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useStudioStore } from '../stores/studio';
import { getRouterAiAdminVideoStatus } from '../api/client';
import type { GenerationRecord } from '../types';
import { formatCreditCost } from '../domain/credits';
import { generationProviderLabel } from '../domain/provider-label';
import { resultError, resultModelLabel } from '../domain/result-presentation';
import { useI18n } from '../i18n';
import { generationDuration, generationStateLabel, reasoningEffortLabel } from '../i18n/presentation';
import ExpandableResultImage from './ExpandableResultImage.vue';
import { resultDownloadUrl } from '../domain/result-download';

const emit = defineEmits<{ history: []; workspace: [] }>();
const studio = useStudioStore();
const { formatDate, formatNumber, t } = useI18n();
const isAdmin = computed(() => studio.isAdmin);
const resultText = computed(() => {
  const record = studio.selected;
  if (!record) return t('generation.resultPending');
  return record.output || (record.error ? resultError(record, isAdmin.value) : t('generation.resultPending'));
});
const presentedOutput = computed(() => {
  const record = studio.selected;
  if (!record?.output) return '';
  const prompt = typeof record.input?.prompt === 'string' ? record.input.prompt.trim() : '';
  return record.kind === 'image' && /^Изображение создано\.?$/iu.test(record.output.trim()) && prompt
    ? prompt
    : record.output;
});
const resultUrls = computed<string[]>(() => {
  if (!studio.selected) return [];
  const local = (studio.selected.localFiles || []).map(file => file.previewUrl || file.url).filter(Boolean) as string[];
  if (local.length) return local;
  try { const value = JSON.parse(studio.selected.resultJson || '{}'); return Array.isArray(value.resultUrls) ? value.resultUrls.filter((url: unknown): url is string => typeof url === 'string') : []; } catch { return []; }
});
const credits = computed(() => studio.selected?.nativeQuote?.credits);
const usage = computed(() => studio.selected?.usage || null);
const tokens = computed(() => usage.value?.total_tokens ?? usage.value?.totalTokens);
const inputTokens = computed(() => usage.value?.input_tokens ?? usage.value?.inputTokens);
const outputTokens = computed(() => usage.value?.output_tokens ?? usage.value?.outputTokens);
const cachedTokens = computed(() => usage.value?.cached_input_tokens ?? usage.value?.cachedInputTokens);
const reasoningTokens = computed(() => usage.value?.reasoning_output_tokens ?? usage.value?.reasoningOutputTokens);
const now = ref(Date.now());
const refreshing = ref(false);
const videoStatus = ref<Record<string, unknown> | null>(null);
const videoStatusError = ref('');
const routerAiVideoJobId = computed(() => studio.selected?.providerId === 'routerai' && studio.selected?.kind === 'video' && studio.selected?.providerVideoId
  ? studio.selected.id.replace(/^routerai:/, '') : '');
const videoReady = computed(() => ['completed', 'succeeded', 'success'].includes(String(videoStatus.value?.status || (videoStatus.value?.data as { status?: string } | undefined)?.status || '').toLowerCase()));
watch(() => studio.selected?.id, () => { videoStatus.value = null; videoStatusError.value = ''; });
async function checkRouterAiVideo() {
  if (!routerAiVideoJobId.value) return;
  videoStatusError.value = '';
  try { videoStatus.value = await getRouterAiAdminVideoStatus(routerAiVideoJobId.value); }
  catch (error) { videoStatusError.value = error instanceof Error ? error.message : t('routerai.admin.statusError'); }
}
let timer: ReturnType<typeof setInterval> | undefined;
const activeStates = new Set(['queued', 'preparing', 'submitting', 'waiting', 'queuing', 'generating', 'running']);
function formatDuration(milliseconds: number) { return generationDuration(milliseconds); }
function formatCount(value: number | null | undefined) { return value == null ? '—' : formatNumber(value); }
function durationFor(record: GenerationRecord, live = false) {
  if (record.generationDurationMs != null) return formatDuration(record.generationDurationMs);
  const startedAt = record.generationStartedAt || record.createdAt;
  const started = startedAt ? Date.parse(startedAt) : Number.NaN;
  return live && activeStates.has(record.state) && Number.isFinite(started) ? formatDuration(now.value - started) : '—';
}
const duration = computed(() => {
  const record = studio.selected;
  return record ? durationFor(record, true) : '—';
});
const isActive = computed(() => Boolean(studio.selected && activeStates.has(studio.selected.state)));
const isCodex = computed(() => studio.selected?.providerId === 'codex');
const isKie = computed(() => Boolean(studio.selected && ['media', 'kie'].includes(studio.selected.providerId)));
const statusTitle = computed(() => {
  const record = studio.selected;
  if (!record) return t('result.currentGeneration');
  if (isKie.value) {
    const states = isAdmin.value
      ? { submitting: t('queue.status.kieSubmitting'), waiting: t('queue.status.kieWaiting'), queuing: t('queue.status.kieQueuing'), generating: t('queue.status.kieWaiting') }
      : { submitting: t('queue.status.publicSubmitting'), waiting: t('generation.state.generating'), queuing: t('generation.state.queued'), generating: t('generation.state.generating') };
    return (states as Record<string, string>)[record.state] || generationStateLabel(record.state);
  }
  return generationStateLabel(record.state);
});
function milliseconds(value?: string) { const parsed = value ? Date.parse(value) : Number.NaN; return Number.isFinite(parsed) ? parsed : null; }
function stepDuration(start?: string, end?: string, live = false) {
  const from = milliseconds(start);
  const to = milliseconds(end) ?? (live ? now.value : null);
  return from != null && to != null && to >= from ? formatDuration(to - from) : '';
}
function clock(value?: string) { return value ? formatDate(value, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''; }
type StepState = 'done' | 'active' | 'pending' | 'error';
const timeline = computed(() => {
  const record = studio.selected;
  if (!record) return [];
  const step = (title: string, detail: string, state: StepState, at?: string, elapsed = '') => ({ title, detail, state, at, elapsed });
  if (!isKie.value) {
    const terminal = ['success', 'fail', 'cancelled', 'blocked'].includes(record.state);
    const processing = ['running', 'generating', 'waiting', 'queuing'].includes(record.state);
    const hasStarted = Boolean(record.generationStartedAt) || terminal || processing || record.state === 'submitting';
    const startedAt = record.generationStartedAt || (hasStarted ? record.createdAt : undefined);
    const completedAt = record.generationCompletedAt;
    const provider = generationProviderLabel(record, studio.catalog);
    return [
      step(t('result.timeline.accepted'), t('result.timeline.acceptedDetail'), 'done', record.createdAt),
      step(t('result.timeline.slot'), startedAt ? t('result.timeline.slotAcquired') : t('result.timeline.slotWaiting'), startedAt ? 'done' : record.state === 'queued' ? 'active' : 'pending', record.createdAt, stepDuration(record.createdAt, startedAt, record.state === 'queued')),
      step(t('result.timeline.preparing'), startedAt ? t('result.timeline.preparedDetail') : t('result.timeline.preparingDetail'), record.state === 'blocked' ? 'error' : startedAt ? 'done' : record.state === 'preparing' ? 'active' : 'pending', record.createdAt),
      step(isAdmin.value ? t('result.timeline.sendProvider', { provider }) : t('result.timeline.sendModel'), startedAt ? (isAdmin.value ? t('result.timeline.sentProvider', { provider }) : t('result.timeline.sentModel')) : t('result.timeline.awaitingSend'), record.state === 'submitting' ? 'active' : startedAt ? 'done' : record.state === 'blocked' ? 'error' : 'pending', startedAt),
      step(isAdmin.value ? t('result.timeline.processingProvider', { provider }) : t('result.timeline.processingModel'), record.state === 'success' ? t('result.timeline.processingDone') : record.state === 'fail' ? t('result.timeline.processingFailed') : processing ? t('result.timeline.processingActive') : t('result.timeline.processingPending'), record.state === 'success' ? 'done' : record.state === 'fail' ? 'error' : processing ? 'active' : 'pending', startedAt, stepDuration(startedAt, completedAt, processing)),
      step(t('result.timeline.receive'), record.state === 'success' ? t('result.timeline.received') : terminal ? t('result.timeline.notReceived') : t('result.timeline.awaitingResult'), record.state === 'success' ? 'done' : terminal ? 'error' : 'pending', completedAt),
    ];
  }
  const queuedAt = record.queuedAt || record.createdAt;
  const submittingAt = record.submittingAt || record.generationStartedAt;
  const remote = ['waiting', 'queuing', 'generating'].includes(record.state);
  const terminal = ['success', 'fail'].includes(record.state);
  const acceptedAt = record.providerAcceptedAt || ((remote || terminal) ? record.generationStartedAt : undefined);
  const completedAt = record.resultReceivedAt || record.generationCompletedAt;
  const progress = typeof record.progress === 'number' && Number.isFinite(record.progress) ? t('result.timeline.progress', { progress: Math.round(record.progress) }) : '';
  return [
    step(t('result.timeline.accepted'), t('result.timeline.acceptedDetail'), 'done', queuedAt),
    step(t('result.timeline.slot'), record.state === 'queued' ? t('result.timeline.slotWaiting') : t('result.timeline.slotAcquired'), record.state === 'queued' ? 'active' : record.preparingAt ? 'done' : 'pending', queuedAt, stepDuration(queuedAt, record.preparingAt, record.state === 'queued')),
    step(t('result.timeline.preparing'), t('result.timeline.preparingDetail'), record.state === 'blocked' ? 'error' : record.state === 'preparing' ? 'active' : submittingAt ? 'done' : 'pending', record.preparingAt, stepDuration(record.preparingAt, submittingAt, record.state === 'preparing')),
    step(isAdmin.value ? t('result.timeline.sendKie') : t('result.timeline.sendTask'), acceptedAt ? (isAdmin.value ? t('result.timeline.kieAccepted') : t('result.timeline.serviceAccepted')) : record.state === 'unknown' ? (isAdmin.value ? t('result.timeline.kieUnconfirmed') : t('result.timeline.sendUnconfirmed')) : (isAdmin.value ? t('result.timeline.sendingProvider') : t('result.timeline.sendingTask')), record.state === 'unknown' ? 'error' : record.state === 'submitting' ? 'active' : acceptedAt ? 'done' : 'pending', submittingAt, stepDuration(submittingAt, acceptedAt, record.state === 'submitting')),
    step(isAdmin.value ? t('result.timeline.generationKie') : t('result.timeline.generation'), terminal ? (record.state === 'success' ? (isAdmin.value ? t('result.timeline.kieCompleted') : t('result.timeline.completed')) : (isAdmin.value ? t('result.timeline.kieFailed') : t('result.timeline.failed'))) : remote ? (isAdmin.value ? t('result.timeline.kieRunning', { progress }) : t('result.timeline.running', { progress })) : t('result.timeline.awaitingConfirmation'), record.state === 'fail' ? 'error' : record.state === 'success' ? 'done' : remote ? 'active' : 'pending', acceptedAt, record.providerDurationMs != null ? formatDuration(record.providerDurationMs) : stepDuration(acceptedAt, completedAt, remote)),
    step(t('result.timeline.receive'), record.state === 'success' ? t('result.timeline.received') : record.state === 'fail' ? t('result.timeline.notReceived') : (isAdmin.value ? t('result.timeline.kieAwaitingResult') : t('result.timeline.awaitingResult')), record.state === 'success' ? 'done' : record.state === 'fail' ? 'error' : 'pending', completedAt),
  ];
});
const route = computed(() => {
  const record = studio.selected;
  if (!record) return '';
  if (!isAdmin.value) return t('result.routePublic');
  const provider = generationProviderLabel(record, studio.catalog);
  const model = resultModelLabel(record, isAdmin.value);
  const kind = record.kind === 'image' ? t('result.imageGenerator') : record.kind === 'text' ? t('result.textKind') : record.kind || t('result.resultKind');
  const effort = typeof record.input?.effort === 'string' ? reasoningEffortLabel(record.input.effort) : '';
  const speed = record.input?.speed === 'fast' ? '⚡ Fast' : record.input?.speed === 'standard' ? t('result.standardSpeed') : '';
  return [provider, model, kind, effort, speed].filter(Boolean).join(' → ');
});
const tokenSummary = computed(() => {
  if (!usage.value) return t('result.tokenUsageMissing');
  const details = [t('result.tokenInput', { count: formatCount(inputTokens.value) }), t('result.tokenOutput', { count: formatCount(outputTokens.value) })];
  if (cachedTokens.value != null) details.push(t('result.tokenCached', { count: formatCount(cachedTokens.value) }));
  if (reasoningTokens.value != null) details.push(t('result.tokenReasoning', { count: formatCount(reasoningTokens.value) }));
  return t('result.tokenSummary', { count: formatCount(tokens.value), details: details.join('; ') });
});
const lastProviderCheck = computed(() => studio.selected?.lastCheckedAt
  ? (isAdmin.value ? t('result.lastKieCheck', { time: clock(studio.selected.lastCheckedAt) }) : t('result.lastStatusCheck', { time: clock(studio.selected.lastCheckedAt) }))
  : (isAdmin.value ? t('result.firstKiePending') : t('result.firstStatusPending')));
const receipt = computed(() => {
  const record = studio.selected;
  if (!record) return '';
  if (isKie.value && activeStates.has(record.state)) {
    const prefix = isAdmin.value ? 'admin' : 'public';
    const messages: Record<string, string> = {
      queued: t(`result.receipt.${prefix}.queued` as 'result.receipt.admin.queued'),
      preparing: t(`result.receipt.${prefix}.preparing` as 'result.receipt.admin.preparing'),
      submitting: t(`result.receipt.${prefix}.submitting` as 'result.receipt.admin.submitting'),
      waiting: t(`result.receipt.${prefix}.waiting` as 'result.receipt.admin.waiting'),
      queuing: t(`result.receipt.${prefix}.queuing` as 'result.receipt.admin.queuing'),
      generating: t(`result.receipt.${prefix}.generating` as 'result.receipt.admin.generating'),
    };
    return t('result.receipt.elapsed', { message: messages[record.state] || generationStateLabel(record.state), duration: duration.value, check: ['waiting', 'queuing', 'generating'].includes(record.state) ? ` ${lastProviderCheck.value}` : '' })
      + (record.providerChargeConfirmedAt ? ` ${t('result.receipt.charged')}.` : '');
  }
  if (activeStates.has(record.state)) return t('result.receipt.active', { provider: isAdmin.value ? `${generationProviderLabel(record, studio.catalog)}: ` : '', state: generationStateLabel(record.state), duration: duration.value, details: isAdmin.value ? t('result.receipt.adminPendingDetails') : '' });
  const costAction = record.providerFreeConfirmedAt ? t('result.receipt.refunded') : record.state === 'success' || record.providerChargeConfirmedAt ? t('result.receipt.charged') : ['fail', 'blocked', 'cancelled'].includes(record.state) ? t('result.receipt.refunded') : t('result.receipt.reserved');
  const parts = [record.state === 'success' ? (isAdmin.value ? t('result.receipt.responseFrom', { provider: generationProviderLabel(record, studio.catalog) }) : t('result.receipt.received')) : `${resultError(record, isAdmin.value)}.`];
  if (credits.value != null) parts.push(t('result.receipt.creditCost', { action: costAction, count: formatCreditCost(credits.value) }));
  if (record.generationDurationMs != null) parts.push(t('result.receipt.generationTime', { duration: duration.value }));
  if (isAdmin.value && isKie.value && record.providerDurationMs != null) parts.push(t('result.receipt.providerTime', { duration: formatDuration(record.providerDurationMs) }));
  if (isAdmin.value && record.providerId === 'codex') parts.push(tokenSummary.value);
  return parts.join(' ');
});
function timestamp(value?: string) { return value ? formatDate(value, { dateStyle: 'short', timeStyle: 'medium' }) : '—'; }
onMounted(() => { timer = setInterval(() => { now.value = Date.now(); }, 1000); });
onBeforeUnmount(() => { if (timer) clearInterval(timer); });

function prepare(record: GenerationRecord) {
  studio.prepareFrom(record);
  emit('workspace');
  requestAnimationFrame(() => { document.querySelector<HTMLTextAreaElement>('.composer-body textarea')?.focus(); });
}
function openHistory() {
  emit('history');
}
async function refreshStatus() {
  refreshing.value = true;
  try { await studio.refresh(); } finally { refreshing.value = false; }
}
</script>

<template>
  <section class="result-card" :data-record-id="studio.selected?.id || ''">
    <div class="panel-heading"><div><span class="eyebrow">{{ t('result.eyebrow') }}</span><h2 :class="{ 'is-success': studio.selected?.state === 'success' }">{{ statusTitle }}</h2></div><span class="result-meta">{{ studio.selected ? resultModelLabel(studio.selected, isAdmin) : t('common.currentTask') }}</span></div>
    <p v-if="studio.selected" class="result-route">{{ route }}</p>
    <p v-if="studio.selected" class="result-receipt" role="status">{{ receipt }}</p>
    <ol v-if="timeline.length" class="generation-timeline" :aria-label="t('result.timeline')">
      <li v-for="item in timeline" :key="item.title" :class="`is-${item.state}`"><span class="timeline-marker" aria-hidden="true"></span><div><strong>{{ item.title }}</strong><p>{{ item.detail }}</p><small v-if="item.at || item.elapsed">{{ clock(item.at) }}<template v-if="item.elapsed"> · {{ item.elapsed }}</template></small></div></li>
    </ol>
    <div v-if="resultUrls.length" class="result-media">
      <video v-if="studio.selected?.kind === 'video'" :src="resultUrls[0]" controls playsinline></video>
      <audio v-else-if="studio.selected?.kind === 'audio'" :src="resultUrls[0]" controls></audio>
      <ExpandableResultImage v-else v-for="(url, index) in resultUrls" :key="url" :src="url"
        :download-url="resultDownloadUrl(studio.selected, index, url)" :alt="t('generation.resultAlt')" />
    </div>
    <pre v-if="presentedOutput" class="result-output">{{ presentedOutput }}</pre>
    <pre v-if="videoStatus" class="result-output">{{ JSON.stringify(videoStatus, null, 2) }}</pre>
    <p v-if="videoStatusError" role="alert">{{ videoStatusError }}</p>
    <p v-else-if="!resultUrls.length" class="result-placeholder">{{ resultText }}</p>
    <div v-if="studio.selected" class="result-facts"><span>{{ t('result.model') }} <strong>{{ resultModelLabel(studio.selected, isAdmin) }}</strong></span><span>{{ isActive ? t('result.elapsed') : t('result.time') }} <strong>{{ duration }}</strong></span><span>{{ t('result.price') }} <strong>{{ credits == null ? '—' : formatCreditCost(credits) }}</strong></span><span v-if="isAdmin">{{ t('result.tokens') }} <strong>{{ formatCount(tokens) }}</strong></span></div>
    <div v-if="isAdmin && usage" class="token-breakdown"><div><span>{{ t('result.totalTokens') }}</span><strong>{{ formatCount(tokens) }}</strong></div><dl><div><dt>{{ t('result.inputTokens') }}</dt><dd>{{ formatCount(inputTokens) }}</dd></div><div><dt>{{ t('result.outputTokens') }}</dt><dd>{{ formatCount(outputTokens) }}</dd></div><div v-if="cachedTokens != null"><dt>{{ t('result.cachedTokens') }}</dt><dd>{{ formatCount(cachedTokens) }}</dd></div><div v-if="reasoningTokens != null"><dt>{{ t('result.reasoningTokens') }}</dt><dd>{{ formatCount(reasoningTokens) }}</dd></div></dl></div>
    <p v-else-if="isAdmin && isCodex && isActive" class="token-pending">{{ t('result.tokensPending') }}</p>
    <div v-if="studio.selected" class="timing-details"><span>{{ t('result.started') }} <strong>{{ timestamp(studio.selected.generationStartedAt || studio.selected.createdAt) }}</strong></span><span>{{ t('result.completed') }} <strong>{{ timestamp(studio.selected.generationCompletedAt) }}</strong></span></div>
    <div v-if="studio.selected" class="result-actions"><a v-if="resultUrls[0]" class="action-button" :href="resultDownloadUrl(studio.selected, 0, resultUrls[0])" download>{{ t('common.download') }}</a><button v-if="routerAiVideoJobId && isAdmin" type="button" class="action-button" @click="checkRouterAiVideo">{{ t('routerai.admin.videoStatus') }}</button><a v-if="routerAiVideoJobId && videoReady" class="action-button" :href="`/api/routerai/admin/jobs/${routerAiVideoJobId}/video/content`" download>{{ t('routerai.admin.videoDownload') }}</a><button v-if="isActive || ['unknown', 'unconfirmed'].includes(studio.selected.state)" type="button" class="action-button" :disabled="refreshing" @click="refreshStatus">{{ refreshing ? t('common.checking') : t('result.checkStatus') }}</button><button type="button" class="action-button" @click="prepare(studio.selected)">{{ t('result.repeat') }}</button><button type="button" class="action-button" @click="prepare(studio.selected)">{{ t('result.editPrompt') }}</button><button type="button" class="action-button" @click="openHistory">{{ t('result.openHistory') }}</button></div>
  </section>
</template>
