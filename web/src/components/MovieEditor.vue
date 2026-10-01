<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useStudioStore } from '../stores/studio';
import { useI18n } from '../i18n';
import { FORMATS, FPS, MAX_SCENES, timeline, type Scene } from '../remotion/model.mjs';
import type { mountPreview } from '../remotion/bridge';
import { listMovieSources, downloadMovieSource, reportMovieError, uploadSource, getMovieDraft, saveMovieDraft } from '../api/client';
import MovieScenario from './MovieScenario.vue';

const studio = useStudioStore();
const { t } = useI18n();
const scenes = ref<Scene[]>([]);
const format = ref<keyof typeof FORMATS>('portrait');
const background = ref('#151522');
const muteClips = ref(false);
const music = ref('');
const musicName = ref('');
const preview = ref<HTMLElement>();
const busy = ref(false);
const progress = ref(0);
const error = ref('');
const download = ref('');
const selectedAsset = ref('');
const sourceLink = ref('');
const script = ref('');
const scenarioState = ref<{ modelId: string; pending?: { id: string; sources: Scene[] } }>({ modelId: '' });
const draftReady = ref(false);
const draftStatus = ref('');
const projectId = studio.activeProjectId;
let revision = 0;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let saveChain = Promise.resolve();
const conflict = ref(false);
const importing = ref(false);
const aiBusy = ref(false);
const previousScenes = ref<Scene[]>();
const editorLocked = computed(() => !draftReady.value || conflict.value || busy.value || importing.value || aiBusy.value);
const importStatus = ref('');
const importFailures = ref<string[]>([]);
let importController: AbortController | undefined;
const ownedUrls = new Set<string>();
let controller: AbortController | undefined;
let player: ReturnType<typeof mountPreview> | undefined;
let bridge: typeof import('../remotion/bridge') | undefined;
let alive = true;
const plan = computed(() => { try { return timeline(scenes.value); } catch { return null; } });
const movieProps = computed(() => ({ scenes: scenes.value.map(scene => ({ ...scene })), background: background.value, muteClips: muteClips.value, music: music.value || undefined }));
const library = computed(() => studio.history.flatMap(record => record.state === 'success' && ['image', 'video'].includes(record.kind || '')
  ? (record.localFiles || []).flatMap((file, index) => {
    const src = file.url || file.previewUrl;
    return src?.startsWith('/api/') ? [{ key: `${record.id}:${index}`, src, kind: record.kind as 'image' | 'video', name: `${record.modelName || record.kind} · ${file.name || index + 1}` }] : [];
  }) : []));
function add(scene: Omit<Scene, 'id'>) {
  if (scenes.value.length >= MAX_SCENES) { error.value = t('movie.limit'); return; }
  scenes.value.push({ ...scene, id: crypto.randomUUID() });
}
function addTitle() { add({ kind: 'title', title: t('movie.defaultTitle'), seconds: 3 }); }
function addLibrary() {
  const asset = library.value.find(item => item.key === selectedAsset.value);
  if (asset) add({ kind: asset.kind, src: asset.src.split('?')[0], name: asset.name, title: '', seconds: 5 });
}
function own(blob: Blob) { const url = URL.createObjectURL(blob); ownedUrls.add(url); return url; }
function release(url?: string) { if (url && ownedUrls.delete(url)) URL.revokeObjectURL(url); }
async function storedSource(blob: Blob, name: string) {
  const saved = await uploadSource(new File([blob], name, { type: blob.type }), { projectId }, true);
  if (saved.ref.startsWith('content:')) return `/api/content/${saved.ref.slice(8)}`;
  const legacy = /^https:\/\/local-assets\.invalid\/([a-f0-9]{64})$/.exec(saved.ref);
  if (!legacy) throw new Error(t('movie.draftFailed'));
  return `/api/sources/${legacy[1]}`;
}
async function upload(event: Event, audio = false) {
  const input = event.target as HTMLInputElement;
  error.value = '';
  importing.value = true;
  try { for (const file of Array.from(input.files || [])) {
    if (file.size > 100 * 1024 * 1024 || !(audio ? file.type.startsWith('audio/') : /^(image\/(png|jpeg|webp)|video\/(mp4|webm))$/.test(file.type))) { error.value = t('movie.fileError'); continue; }
    if (audio) { release(music.value); music.value = await storedSource(file, file.name); musicName.value = file.name; await persistDraft(); break; }
    if (scenes.value.length >= MAX_SCENES) { error.value = t('movie.limit'); break; }
    add({ kind: file.type.startsWith('image/') ? 'image' : 'video', src: await storedSource(file, file.name), name: file.name, title: '', seconds: 5 });
    await persistDraft();
  } } catch (reason) { error.value = reason instanceof Error ? reason.message : t('movie.draftFailed'); }
  finally { importing.value = false; }
  input.value = '';
}
function remove(index: number) {
  const src = scenes.value[index]?.src;
  scenes.value.splice(index, 1);
  if (src && !scenes.value.some(scene => scene.src === src) && !previousScenes.value?.some(scene => scene.src === src)) release(src);
}
function applyScenario(plan: Scene[]) {
  previousScenes.value = scenes.value.map(scene => ({ ...scene }));
  scenes.value = plan;
}
function undoScenario() {
  if (!previousScenes.value || editorLocked.value) return;
  scenes.value = previousScenes.value;
  previousScenes.value = undefined;
}
function move(index: number, offset: number) {
  const other = index + offset;
  if (other < 0 || other >= scenes.value.length) return;
  [scenes.value[index], scenes.value[other]] = [scenes.value[other]!, scenes.value[index]!];
}
function clearMusic() { release(music.value); music.value = ''; musicName.value = ''; }
async function importSources() {
  if (editorLocked.value || !sourceLink.value.trim()) return;
  const slots = MAX_SCENES - scenes.value.length;
  if (slots <= 0) { error.value = t('movie.limit'); return; }
  importing.value = true; error.value = ''; importFailures.value = []; importStatus.value = t('movie.importListing');
  const current = new AbortController(); importController = current;
  let loaded = 0; let failed = 0; let bytes = 0;
  try {
    const result = await listMovieSources(sourceLink.value.trim(), slots, current.signal);
    for (let index = 0; index < result.files.length; index++) {
      if (current.signal.aborted || !alive) break;
      const file = result.files[index]!;
      importStatus.value = t('movie.importProgress', { current: index + 1, total: result.files.length });
      try {
        if (bytes + (file.size || 0) > 300 * 1024 * 1024) {
          failed += result.files.length - index; importFailures.value.push(t('movie.importByteLimit')); reportMovieError('MOVIE_IMPORT_LIMIT'); break;
        }
        const blob = await downloadMovieSource(file.id, current.signal);
        if (current.signal.aborted || !alive) break;
        if (bytes + blob.size > 300 * 1024 * 1024) {
          failed += result.files.length - index; importFailures.value.push(t('movie.importByteLimit')); reportMovieError('MOVIE_IMPORT_LIMIT'); break;
        }
        bytes += blob.size;
        const src = await storedSource(blob, file.name);
        add({ kind: file.type.startsWith('image/') ? 'image' : 'video', src, name: file.name, title: '', seconds: 5 });
        await persistDraft();
        loaded++;
      } catch (reason) {
        if (current.signal.aborted) break;
        failed++;
        importFailures.value.push(`${file.name}: ${reason instanceof Error ? reason.message : t('movie.fileError')}`);
        reportMovieError('MOVIE_IMPORT_FAILED');
      }
    }
    if (alive) importStatus.value = t('movie.importDone', { count: loaded, skipped: result.skipped + failed }) + (result.truncated ? ` ${t('movie.importLimit')}` : '') + (current.signal.aborted ? ` ${t('movie.importCancelled')}` : '');
  } catch (reason) {
    if (alive) {
      if (current.signal.aborted) importStatus.value = t('movie.importCancelled');
      else { importStatus.value = ''; error.value = reason instanceof Error ? reason.message : t('movie.fileError'); }
    }
  } finally { if (alive) importing.value = false; }
}
async function updatePreview() {
  if (!bridge || !preview.value) return;
  if (!plan.value) { player?.dispose(); player = undefined; return; }
  player ||= bridge.mountPreview(preview.value, () => { error.value = t('movie.renderError'); });
  const [width, height] = FORMATS[format.value];
  player.update(movieProps.value, width, height);
}
watch([movieProps, format], () => { release(download.value); download.value = ''; void updatePreview(); }, { deep: true });
async function render() {
  if (editorLocked.value || !plan.value || !bridge) return;
  busy.value = true; error.value = ''; progress.value = 0;
  release(download.value); download.value = '';
  controller = new AbortController();
  try {
    const [width, height] = FORMATS[format.value];
    const blob = await bridge.exportMovie(movieProps.value, width, height, controller.signal, value => { progress.value = Math.round(value * 100); });
    if (alive && !controller.signal.aborted) { download.value = own(blob); progress.value = 100; }
  } catch (reason) {
    if (alive && !controller.signal.aborted) {
      const unsupported = reason instanceof Error && reason.message === 'BROWSER_UNSUPPORTED';
      error.value = t(unsupported ? 'movie.unsupported' : 'movie.renderError');
      if (!unsupported) bridge.reportMovieError('MOVIE_RENDER_FAILED');
    }
  } finally { if (alive) busy.value = false; }
}
onMounted(async () => {
  try {
    const draft = await getMovieDraft(projectId);
    if (draft) {
      scenes.value = draft.scenes; format.value = draft.format; background.value = draft.background;
      muteClips.value = draft.muteClips; music.value = draft.music; musicName.value = draft.musicName;
      script.value = draft.script; sourceLink.value = draft.sourceLink; scenarioState.value = draft.scenarioState || { modelId: '' }; revision = draft.revision;
    }
    draftReady.value = true; draftStatus.value = t('movie.draftSaved');
  } catch (reason) { error.value = reason instanceof Error ? reason.message : t('movie.draftFailed'); }
  try { bridge = await import('../remotion/bridge'); if (alive) { await nextTick(); await updatePreview(); } }
  catch { if (alive) error.value = t('movie.renderError'); }
});
function snapshot() {
  return JSON.parse(JSON.stringify({ scenes: scenes.value, format: format.value, background: background.value, muteClips: muteClips.value,
    music: music.value, musicName: musicName.value, script: script.value, sourceLink: sourceLink.value, scenarioState: scenarioState.value }));
}
function persistDraft() {
  if (!draftReady.value || conflict.value) return Promise.resolve();
  if (saveTimer) clearTimeout(saveTimer);
  const draft = snapshot();
  draftStatus.value = t('movie.draftSaving');
  const operation = saveChain.then(async () => {
    if (conflict.value) return;
    const saved = await saveMovieDraft(projectId, draft, revision); revision = saved.revision;
    if (alive && JSON.stringify(draft) === JSON.stringify(snapshot())) draftStatus.value = t('movie.draftSaved');
  });
  saveChain = operation.catch(reason => {
    if (String(reason?.message).includes('другой вкладке')) conflict.value = true;
    if (alive) { draftStatus.value = t('movie.draftFailed'); error.value = reason instanceof Error ? reason.message : t('movie.draftFailed'); }
  });
  return operation;
}
watch([scenes, format, background, muteClips, music, musicName, script, sourceLink, scenarioState], () => {
  if (!draftReady.value || conflict.value) return;
  draftStatus.value = t('movie.draftSaving'); if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { void persistDraft().catch(() => {}); }, 400);
}, { deep: true });
function protectUnsaved(event: BeforeUnloadEvent) {
  if (importing.value || draftStatus.value === t('movie.draftSaving') || draftStatus.value === t('movie.draftFailed')) { event.preventDefault(); event.returnValue = ''; }
}
onMounted(() => window.addEventListener('beforeunload', protectUnsaved));
onBeforeUnmount(() => { window.removeEventListener('beforeunload', protectUnsaved); if (saveTimer) { clearTimeout(saveTimer); void persistDraft().catch(() => {}); } alive = false; controller?.abort(); importController?.abort(); player?.dispose(); for (const url of ownedUrls) URL.revokeObjectURL(url); });
</script>

<template>
  <section class="movie-editor">
    <p>{{ t('movie.intro') }}</p>
    <p role="status" class="movie-draft-status">{{ draftStatus }}</p>
    <button v-if="draftReady && !conflict && draftStatus === t('movie.draftFailed')" type="button" @click="persistDraft().catch(() => {})">{{ t('movie.draftRetry') }}</button>
    <div class="movie-layout">
      <div>
        <MovieScenario v-if="draftReady" v-model:script="script" v-model:saved-state="scenarioState" :scenes="scenes" :disabled="editorLocked" @busy="aiBusy = $event" @apply="applyScenario" />
        <button v-if="previousScenes" type="button" class="movie-ai-undo" :disabled="editorLocked" @click="undoScenario">{{ t('movie.aiUndo') }}</button>
        <form class="movie-source-import" @submit.prevent="importSources">
          <label>{{ t('movie.sourceLink') }}<input v-model="sourceLink" type="url" required placeholder="https://disk.yandex.ru/d/…" :disabled="editorLocked"></label>
          <div class="movie-scene-actions"><button type="submit" :disabled="editorLocked || !sourceLink.trim()">{{ t('movie.importAll') }}</button><button v-if="importing" type="button" @click="importController?.abort()">{{ t('movie.cancel') }}</button></div>
          <p v-if="importStatus" role="status">{{ importStatus }}</p>
          <ul v-if="importFailures.length" role="status"><li v-for="(failure, index) in importFailures" :key="index">{{ failure }}</li></ul>
          <p class="movie-note">{{ t('movie.importHelp') }}</p>
        </form>
        <fieldset :disabled="editorLocked" class="movie-controls">
          <label>{{ t('movie.format') }}<select v-model="format"><option value="portrait">9:16 · 720 × 1280</option><option value="landscape">16:9 · 1280 × 720</option><option value="square">1:1 · 720 × 720</option></select></label>
          <label>{{ t('movie.background') }}<input v-model="background" type="color"></label>
          <button type="button" class="movie-title-add" @click="addTitle">＋ {{ t('movie.title') }}</button>
          <label class="movie-file">{{ t('movie.files') }}<input type="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/webm" multiple @change="upload($event)"></label>
          <label>{{ t('movie.library') }}<select v-model="selectedAsset"><option value="">{{ t('movie.select') }}</option><option v-for="asset in library" :key="asset.key" :value="asset.key">{{ asset.name }}</option></select></label>
          <button type="button" :disabled="!selectedAsset" @click="addLibrary">{{ t('movie.add') }}</button>
          <label>{{ t('movie.music') }}<input type="file" accept="audio/*" @change="upload($event, true)"></label>
          <span v-if="musicName">{{ musicName }} <button type="button" @click="clearMusic">×</button></span>
          <label class="movie-check"><input v-model="muteClips" type="checkbox"> {{ t('movie.mute') }}</label>
        </fieldset>
        <p v-if="!scenes.length" class="movie-empty">{{ t('movie.empty') }}</p>
        <fieldset :disabled="editorLocked" class="movie-scenes">
          <article v-for="(scene, index) in scenes" :key="scene.id" class="movie-scene">
            <strong>{{ index + 1 }} · {{ scene.name || t('movie.title') }}</strong>
            <label v-if="scene.kind !== 'title'">{{ t('movie.aiDescription') }}<input v-model="scene.name" type="text" maxlength="255"></label>
            <label>{{ t('movie.caption') }}<textarea v-model="scene.title" maxlength="300" rows="2"></textarea></label>
            <label>{{ t('movie.seconds') }}<input v-model.number="scene.seconds" type="number" min="1" max="30" step="0.5"></label>
            <div class="movie-scene-actions"><button type="button" :disabled="index === 0" :aria-label="t('movie.up')" @click="move(index, -1)">↑</button><button type="button" :disabled="index === scenes.length - 1" :aria-label="t('movie.down')" @click="move(index, 1)">↓</button><button type="button" @click="remove(index)">{{ t('movie.remove') }}</button></div>
          </article>
        </fieldset>
      </div>
      <div class="movie-output">
        <h2>{{ t('movie.preview') }}</h2>
        <div ref="preview" class="movie-preview"></div>
        <p v-if="plan">{{ scenes.length }} · {{ plan.durationInFrames / FPS }} {{ t('movie.secondsShort') }}</p>
        <p v-else-if="scenes.length" role="alert">{{ t('movie.invalid') }}</p>
        <button type="button" class="movie-render" :disabled="editorLocked || !plan || !bridge" @click="render">{{ t('movie.export') }}</button>
        <div v-if="busy" role="status"><progress :value="progress" max="100"></progress> {{ progress }}% <button type="button" @click="controller?.abort()">{{ t('movie.cancel') }}</button></div>
        <a v-if="download" class="movie-download" :href="download" download="ai-media-movie.mp4">{{ t('movie.download') }}</a>
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <p class="movie-note">{{ t('movie.note') }}</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.movie-editor { width:100%; height:100%; min-height:0; min-width:0; overflow-y:auto; padding:0 4px 32px; container:movie / inline-size; scrollbar-width:thin; }
.movie-layout { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:24px; }
.movie-layout > div { min-width:0; }
.movie-controls,.movie-scenes { display:grid; gap:12px; border:0; padding:0; min-width:0; }
.movie-controls label,.movie-scene label { display:grid; gap:6px; }
.movie-source-import { display:grid; gap:10px; padding:16px; margin-bottom:18px; border:1px solid #7775; border-radius:12px; }
.movie-source-import label { display:grid; gap:6px; min-width:0; }
.movie-source-import p { margin:0; overflow-wrap:anywhere; }
.movie-controls label.movie-check { display:flex; align-items:center; gap:8px; }
.movie-controls input[type=checkbox] { width:auto; }
.movie-editor input[type=file] { width:100%; min-width:0; font:inherit; }
.movie-editor select,.movie-editor textarea,.movie-editor input[type=number],.movie-editor input[type=url],.movie-editor input[type=text] { width:100%; min-width:0; padding:10px; background:var(--panel, #171923); color:inherit; border:1px solid #7775; border-radius:8px; }
.movie-ai-undo { margin-bottom:18px; }
.movie-editor button,.movie-download { padding:10px 14px; border:1px solid #7775; border-radius:8px; background:var(--panel, #242338); color:inherit; cursor:pointer; }
.movie-editor button:disabled { opacity:.45; cursor:default; }
.movie-scenes { margin-top:20px; }
.movie-scene { display:grid; gap:10px; padding:16px; border:1px solid #7775; border-radius:12px; }
.movie-scene strong { overflow-wrap:anywhere; }
.movie-scene-actions { display:flex; flex-wrap:wrap; gap:6px; }
.movie-preview { min-height:150px; background:#10111b; border-radius:12px; overflow:hidden; }
.movie-output h2 { margin-top:0; }
.movie-render { margin:12px 0; }
.movie-download { display:block; margin:12px 0; text-align:center; }
.movie-note,.movie-empty { opacity:.7; font-size:13px; line-height:1.6; }
@container movie (max-width:700px) { .movie-layout { grid-template-columns:minmax(0,1fr); } .movie-output { grid-row:1; } }
</style>
