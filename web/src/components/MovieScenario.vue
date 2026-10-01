<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from '../i18n';
import { useStudioStore } from '../stores/studio';
import { getCodexCatalog, getCodexQuote, getCodexJob, submitCodex, reportMovieError } from '../api/client';
import { scenarioPrompt, parseScenario } from '../remotion/scenario.mjs';
import type { Scene } from '../remotion/model.mjs';
import type { CodexModel, GenerationRecord } from '../types';

const props = defineProps<{ scenes: Scene[]; disabled: boolean }>();
const emit = defineEmits<{ busy: [value: boolean]; apply: [scenes: Scene[]] }>();
const { t } = useI18n();
const studio = useStudioStore();
const storedScript = defineModel<string>('script', { default: '' });
const script = ref(storedScript.value);
watch(script, value => { storedScript.value = value; });
const savedState = defineModel<{ modelId: string; pending?: { id: string; sources: Scene[] } }>('savedState', { default: () => ({ modelId: '' }) });
const models = ref<CodexModel[]>([]);
const modelId = ref(savedState.value.modelId);
const loading = ref(false);
const status = ref('');
const error = ref('');
const cost = ref<number | null>(null);
const quoting = ref(false);
const selected = computed(() => models.value.find(model => model.id === modelId.value));
const effort = computed(() => selected.value?.efforts.includes('low') ? 'low' : selected.value?.defaultEffort || selected.value?.efforts[0] || 'medium');
const pending = ref<{ id: string; sources: Scene[] } | undefined>(savedState.value.pending);
watch([modelId, pending], () => { savedState.value = { modelId: modelId.value, pending: pending.value }; }, { deep: true });
let alive = true;
let quoteRevision = 0;
let stop = false;
let wake: (() => void) | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
const wait = () => new Promise<void>(resolve => { wake = resolve; timer = setTimeout(resolve, 1500); });
function stopWaiting() { stop = true; if (timer) clearTimeout(timer); wake?.(); }
function newScenario() { pending.value = undefined; status.value = ''; error.value = ''; }

async function loadCatalog() {
  try {
    const catalog = await getCodexCatalog();
    if (!alive) return;
    models.value = catalog.models;
    modelId.value = catalog.models.find(model => model.id === modelId.value)?.id || catalog.models.find(model => model.id === studio.codexModel)?.id || catalog.models.find(model => model.isDefault)?.id || catalog.models[0]?.id || '';
  } catch (reason) { if (alive) error.value = reason instanceof Error ? reason.message : t('movie.aiUnavailable'); }
}
watch([modelId, effort], async () => {
  const revision = ++quoteRevision; cost.value = null; quoting.value = true;
  try {
    const result = await getCodexQuote(modelId.value, effort.value, 'standard');
    if (alive && revision === quoteRevision) {
      const value = result.quote?.credits;
      cost.value = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
      error.value = cost.value === null ? result.error || t('movie.aiUnavailable') : '';
    }
  } catch (reason) { if (alive && revision === quoteRevision) error.value = reason instanceof Error ? reason.message : t('movie.aiUnavailable'); }
  finally { if (alive && revision === quoteRevision) quoting.value = false; }
});

async function generate() {
  if (loading.value || props.disabled || !pending.value && (!script.value.trim() || cost.value === null || quoting.value)) return;
  loading.value = true; emit('busy', true); error.value = ''; status.value = t('movie.aiWorking'); stop = false;
  try {
    let job: GenerationRecord;
    if (pending.value) job = await getCodexJob(pending.value.id);
    else {
      const sources = props.scenes.map(scene => ({ ...scene }));
      const prompt = scenarioPrompt(script.value, sources);
      const requestId = crypto.randomUUID();
      pending.value = { id: requestId, sources };
      // Retain the id if submission response is lost; status checks never resubmit or charge again.
      job = await submitCodex({ requestId, prompt, model: modelId.value, effort: effort.value, speed: 'standard', kind: 'text',
        projectId: studio.activeProjectId, chatId: studio.activeChatId === 'system:recent' ? null : studio.activeChatId });
    }
    const deadline = Date.now() + 10 * 60 * 1000;
    while (alive && !stop && !['success', 'fail', 'failed', 'unknown', 'unconfirmed', 'cancelled'].includes(job.state)) {
      if (Date.now() >= deadline) { stop = true; break; }
      await wait();
      if (!alive || stop) break;
      job = await getCodexJob(pending.value!.id);
    }
    if (!alive) return;
    if (stop) { status.value = t('movie.aiStopped'); return; }
    if (job.state !== 'success') {
      if (['fail', 'failed', 'cancelled'].includes(job.state)) pending.value = undefined;
      throw new Error(job.error || t('movie.aiFailed'));
    }
    let plan: Scene[];
    try { plan = parseScenario(job.output || '', pending.value!.sources); }
    catch {
      pending.value = undefined;
      reportMovieError('MOVIE_PLAN_INVALID');
      throw new Error(t('movie.aiInvalid'));
    }
    // Source files may have been removed after stopping a previous wait.
    const available = new Set(props.scenes.map(scene => scene.src).filter(Boolean));
    if (plan.some(scene => scene.src && !available.has(scene.src))) { pending.value = undefined; throw new Error(t('movie.aiSourcesChanged')); }
    emit('apply', plan); pending.value = undefined; status.value = t('movie.aiDone');
    void studio.refresh().catch(() => {});
  } catch (reason) { if (alive) { status.value = ''; error.value = reason instanceof Error ? reason.message : t('movie.aiFailed'); } }
  finally { if (alive) { loading.value = false; emit('busy', false); } }
}
onMounted(loadCatalog);
onBeforeUnmount(() => { alive = false; stopWaiting(); });
</script>

<template>
  <section class="movie-scenario">
    <h2>{{ t('movie.aiHeading') }}</h2>
    <fieldset :disabled="disabled || loading || !!pending">
      <label>{{ t('movie.aiScript') }}<textarea v-model="script" rows="4" maxlength="8000" :placeholder="t('movie.aiPlaceholder')"></textarea></label>
      <label>{{ t('movie.aiModel') }}<select v-model="modelId"><option v-for="model in models" :key="model.id" :value="model.id">{{ model.name }}</option></select></label>
    </fieldset>
    <p class="movie-note">{{ t('movie.aiHelp') }}</p>
    <p v-if="pending" class="movie-note">{{ t('movie.aiPending') }}</p>
    <p v-if="cost !== null">{{ t('movie.aiCost', { credits: cost }) }}</p>
    <div class="movie-scene-actions">
      <button type="button" class="movie-ai-generate" :disabled="disabled || loading || !pending && (!script.trim() || cost === null || quoting)" @click="generate">{{ t(pending ? 'movie.aiCheck' : 'movie.aiGenerate') }}</button>
      <button v-if="loading" type="button" class="movie-ai-stop" @click="stopWaiting">{{ t('movie.aiStop') }}</button>
      <button v-else-if="pending" type="button" :disabled="disabled" @click="newScenario">{{ t('movie.aiNew') }}</button>
      <button v-if="!models.length" type="button" :disabled="loading || disabled" @click="loadCatalog">{{ t('movie.aiReload') }}</button>
    </div>
    <p v-if="status" class="movie-ai-status" role="status">{{ status }}</p>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.movie-scenario { display:grid; gap:10px; border:1px solid #7775; border-radius:12px; padding:16px; margin:0 0 18px; }
.movie-scenario h2 { font-size:18px; margin:0; }
.movie-scenario fieldset { display:grid; gap:10px; border:0; padding:0; margin:0; min-width:0; }
.movie-scenario label { display:grid; gap:6px; min-width:0; }
.movie-scenario textarea,.movie-scenario select { width:100%; min-width:0; padding:10px; background:var(--panel,#171923); color:inherit; border:1px solid #7775; border-radius:8px; font:inherit; }
.movie-scenario p { margin:0; overflow-wrap:anywhere; }
.movie-note { opacity:.7; font-size:13px; line-height:1.6; }
.movie-scene-actions { display:flex; flex-wrap:wrap; gap:6px; }
.movie-scenario button { padding:10px 14px; border:1px solid #7775; border-radius:8px; background:var(--panel,#242338); color:inherit; cursor:pointer; }
.movie-scenario button:disabled { opacity:.45; cursor:default; }
</style>
