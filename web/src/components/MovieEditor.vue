<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useStudioStore } from '../stores/studio';
import { useI18n } from '../i18n';
import { FORMATS, FPS, MAX_SCENES, MAX_SECONDS, MAX_STILL_SECONDS, timeline, type Scene } from '../remotion/model.mjs';
import type { mountPreview } from '../remotion/bridge';
import { listMovieSources, downloadMovieSource, reportMovieError, uploadSource, getMovieDraft, saveMovieDraft } from '../api/client';
import MovieScenario from './MovieScenario.vue';
import MovieMaterialThumbnail from './MovieMaterialThumbnail.vue';

const studio = useStudioStore();
const { t } = useI18n();
const scenes = ref<Scene[]>([]);
const selectedSceneId = ref('');
const selectedSceneIndex = computed(() => scenes.value.findIndex(scene => scene.id === selectedSceneId.value));
const selectedScene = computed(() => scenes.value[selectedSceneIndex.value]);
watch(() => scenes.value.map(scene => scene.id), (ids, previous = []) => {
  if (!ids.includes(selectedSceneId.value)) {
    const index = Math.max(0, previous.indexOf(selectedSceneId.value));
    selectedSceneId.value = ids[Math.min(index, ids.length - 1)] || '';
  }
}, { flush: 'sync' });
function sceneLabel(scene: Scene) { return scene.name || scene.title || t('movie.title'); }
function sceneType(scene: Scene) { return t(`movie.kind.${scene.kind === 'title' ? 'text' : scene.kind === 'image' ? 'image' : scene.kind === 'video' ? 'video' : 'file'}`); }
const format = ref<keyof typeof FORMATS>('portrait');
const background = ref('#151522');
const muteClips = ref(false);
const music = ref('');
const musicName = ref('');
const preview = ref<HTMLElement>();
const materialVideo = ref<HTMLVideoElement>();
const busy = ref(false);
const progress = ref(0);
const preparing = ref('');
const recovering = ref(false);
const error = ref('');
const download = ref('');
const previewDownload = ref('');
const previewExtension = ref('webm');
const recording = ref(false);
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
watch(editorLocked, locked => { if (locked) materialVideo.value?.pause(); }, { flush: 'sync' });
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
  const id = crypto.randomUUID();
  scenes.value.push({ ...scene, id });
  selectedSceneId.value = id;
}
function addTitle() { add({ kind: 'title', title: t('movie.defaultTitle'), seconds: 3 }); }
async function sourceSeconds(kind: string, source: string | Blob) {
  if (kind !== 'video') return 5;
  try { return await (await import('../remotion/video-duration.mjs')).videoSeconds(source); }
  catch (reason) { throw new Error(t(reason instanceof Error && reason.message === 'MOVIE_VIDEO_TOO_LONG' ? 'movie.clipTooLong' : 'movie.durationFailed')); }
}
async function fullClip(scene: Scene) {
  if (!scene.src || editorLocked.value) return;
  importing.value = true; error.value = '';
  try { scene.seconds = await sourceSeconds('video', scene.src); }
  catch (reason) { error.value = reason instanceof Error ? reason.message : t('movie.durationFailed'); }
  finally { importing.value = false; }
}
async function addLibrary() {
  const asset = library.value.find(item => item.key === selectedAsset.value);
  if (!asset || editorLocked.value) return;
  importing.value = true; error.value = '';
  try {
    const src = asset.src.split('?')[0];
    add({ kind: asset.kind, src, name: asset.name, title: '', seconds: await sourceSeconds(asset.kind, src) });
  } catch (reason) { error.value = reason instanceof Error ? reason.message : t('movie.durationFailed'); }
  finally { importing.value = false; }
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
    const kind = file.type.startsWith('image/') ? 'image' : 'video';
    const seconds = await sourceSeconds(kind, file);
    add({ kind, src: await storedSource(file, file.name), name: file.name, title: '', seconds });
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
  const reordered = [...scenes.value];
  [reordered[index], reordered[other]] = [reordered[other]!, reordered[index]!];
  scenes.value = reordered;
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
        const kind = file.type.startsWith('image/') ? 'image' : 'video';
        const seconds = await sourceSeconds(kind, blob);
        const src = await storedSource(blob, file.name);
        add({ kind, src, name: file.name, title: '', seconds });
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
watch([movieProps, format], () => { release(download.value); download.value = ''; release(previewDownload.value); previewDownload.value = ''; void updatePreview(); }, { deep: true });
async function downloadPreview() {
  if (editorLocked.value || !plan.value || !player) return;
  busy.value = true; recording.value = true; error.value = ''; progress.value = 0;
  release(previewDownload.value); previewDownload.value = '';
  controller = new AbortController();
  try {
    const blob = await player.record(controller.signal, value => { progress.value = Math.round(value * 100); });
    if (!alive || controller.signal.aborted) return;
    previewExtension.value = blob.type.startsWith('video/mp4') ? 'mp4' : 'webm';
    previewDownload.value = own(blob);
    const link = document.createElement('a'); link.href = previewDownload.value; link.download = `ai-media-preview.${previewExtension.value}`;
    document.body.append(link); link.click(); link.remove();
  } catch (reason) {
    if (alive && !controller.signal.aborted) {
      const code = reason instanceof Error ? reason.message : '';
      error.value = t(code === 'PREVIEW_RECORD_UNSUPPORTED' ? 'movie.recordUnsupported'
        : code === 'PREVIEW_RECORD_AUDIO_REQUIRED' ? 'movie.recordAudio'
        : code === 'PREVIEW_RECORD_TAB_REQUIRED' ? 'movie.recordTab' : 'movie.recordFailed');
      if (!(reason instanceof Error && reason.name === 'NotAllowedError')) reportMovieError('MOVIE_RENDER_FAILED');
    }
  } finally { if (alive) { busy.value = false; recording.value = false; } }
}
async function render() {
  if (editorLocked.value || !plan.value || !bridge) return;
  busy.value = true; error.value = ''; progress.value = 0; recovering.value = false;
  release(download.value); download.value = '';
  controller = new AbortController();
  player?.dispose(); player = undefined;
  try {
    const [width, height] = FORMATS[format.value];
    const blob = await bridge.exportMovie(movieProps.value, width, height, controller.signal,
      value => { preparing.value = ''; progress.value = Math.round(value * 100); },
      (completed, total) => { preparing.value = t('movie.preparing', { current: completed, total }); },
      () => { recovering.value = true; });
    if (alive && !controller.signal.aborted) { download.value = own(blob); progress.value = 100; }
  } catch (reason) {
    if (alive && !controller.signal.aborted) {
      const unsupported = reason instanceof Error && reason.message === 'BROWSER_UNSUPPORTED';
      error.value = reason instanceof bridge.MovieMediaError
        ? t(reason.scene ? `movie.scene${reason.kind === 'video' ? 'Video' : 'Audio'}Unsupported` : 'movie.musicUnsupported', { scene: reason.scene })
        : t(unsupported ? 'movie.unsupported' : 'movie.renderError');
      const failure = reason instanceof bridge.MovieExportError ? reason.failure : undefined;
      if (failure) error.value += ` (${failure})`;
      if (!unsupported) bridge.reportMovieError('MOVIE_RENDER_FAILED', failure);
    }
  } finally { if (alive) { busy.value = false; preparing.value = ''; recovering.value = false; void updatePreview(); } }
}
async function loadDraft() {
  draftStatus.value = t('movie.draftSaving'); error.value = '';
  try {
    const draft = await getMovieDraft(projectId);
    if (!alive) return;
    if (draft) {
      scenes.value = draft.scenes; format.value = draft.format; background.value = draft.background;
      muteClips.value = draft.muteClips; music.value = draft.music; musicName.value = draft.musicName;
      script.value = draft.script; sourceLink.value = draft.sourceLink; scenarioState.value = draft.scenarioState || { modelId: '' }; revision = draft.revision;
    }
    draftReady.value = true; draftStatus.value = t('movie.draftSaved');
  } catch (reason) { if (alive) { draftStatus.value = t('movie.draftFailed'); error.value = reason instanceof Error ? reason.message : t('movie.draftFailed'); } }
}
onMounted(async () => {
  await loadDraft();
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
  <section class="movie-editor" :class="{ 'is-recording': recording }">
    <p>{{ t('movie.intro') }}</p>
    <p role="status" class="movie-draft-status">{{ draftStatus }}</p>
    <button v-if="!conflict && draftStatus === t('movie.draftFailed')" type="button" @click="draftReady ? persistDraft().catch(() => {}) : loadDraft()">{{ t('movie.draftRetry') }}</button>
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
          <legend>{{ t('movie.materials') }} · {{ scenes.length }}</legend>
          <div class="movie-material-grid">
            <button v-for="(scene, index) in scenes" :key="scene.id" type="button" class="movie-material"
              :class="{ 'is-selected': scene.id === selectedSceneId }" :aria-pressed="scene.id === selectedSceneId"
              aria-controls="movie-scene-details" :title="sceneLabel(scene)" @click="selectedSceneId = scene.id">
              <span class="movie-material-number">{{ index + 1 }}</span>
              <MovieMaterialThumbnail :kind="scene.kind" :src="scene.src">
              <svg class="movie-material-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                <g v-if="scene.kind === 'image'"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-6 5 7"/></g>
                <g v-else-if="scene.kind === 'video'"><rect x="2" y="5" width="14" height="14" rx="3"/><path d="m16 10 6-4v12l-6-4z"/></g>
                <g v-else-if="scene.kind === 'title'"><path d="M4 6V3h16v3M12 3v18M8 21h8"/></g>
                <g v-else><path d="M14 2H5v20h14V7zM14 2v5h5M8 12h8M8 16h8"/></g>
              </svg>
              </MovieMaterialThumbnail>
              <span class="movie-material-name">{{ sceneLabel(scene) }}</span>
              <span class="movie-material-meta">{{ sceneType(scene) }} · {{ scene.seconds }} {{ t('movie.secondsShort') }}</span>
            </button>
          </div>
        </fieldset>
      </div>
      <div class="movie-output">
        <h2>{{ t('movie.preview') }}</h2>
        <div ref="preview" class="movie-preview"></div>
        <p v-if="plan">{{ scenes.length }} · {{ plan.durationInFrames / FPS }} {{ t('movie.secondsShort') }}</p>
        <p v-else-if="scenes.length" role="alert">{{ t('movie.invalid') }}</p>
        <button type="button" class="movie-render" :disabled="editorLocked || !plan || !bridge" @click="render">{{ t('movie.export') }}</button>
        <button type="button" class="movie-record-preview" :disabled="editorLocked || !plan || !bridge" @click="downloadPreview">{{ t('movie.recordPreview') }}</button>
        <p class="movie-note">{{ t('movie.recordNote') }}</p>
        <div v-if="busy" role="status"><progress :value="progress" max="100"></progress> {{ preparing || `${recovering ? t('movie.recovering') + ' ' : ''}${progress}%` }} <button type="button" @click="controller?.abort()">{{ t('movie.cancel') }}</button></div>
        <a v-if="download" class="movie-download" :href="download" download="ai-media-movie.mp4">{{ t('movie.download') }}</a>
        <a v-if="previewDownload" class="movie-preview-download" :href="previewDownload" :download="`ai-media-preview.${previewExtension}`">{{ t('movie.recordDownload') }} ({{ previewExtension.toUpperCase() }})</a>
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <p class="movie-note">{{ t('movie.note') }}</p>
        <fieldset id="movie-scene-details" :disabled="editorLocked" class="movie-details">
          <legend>{{ t('movie.details') }}</legend>
          <article v-if="selectedScene" :key="selectedScene.id" class="movie-scene">
            <strong>{{ selectedSceneIndex + 1 }} · {{ sceneLabel(selectedScene) }}</strong>
            <span class="movie-note">{{ sceneType(selectedScene) }}</span>
            <img v-if="selectedScene.kind === 'image' && selectedScene.src" class="movie-source-preview" :src="selectedScene.src" :alt="sceneLabel(selectedScene)">
            <video v-else-if="selectedScene.kind === 'video' && selectedScene.src" ref="materialVideo" class="movie-source-preview" :src="selectedScene.src" :controls="!editorLocked" preload="metadata" playsinline></video>
            <label v-if="selectedScene.kind !== 'title'">{{ t('movie.aiDescription') }}<input v-model="selectedScene.name" type="text" maxlength="255"></label>
            <label>{{ t('movie.caption') }}<textarea v-model="selectedScene.title" maxlength="300" rows="3"></textarea></label>
            <label>{{ t('movie.seconds') }}<input v-model.number="selectedScene.seconds" type="number" :min="selectedScene.kind === 'video' ? 1 / FPS : 1" :max="selectedScene.kind === 'video' ? MAX_SECONDS : MAX_STILL_SECONDS" :step="selectedScene.kind === 'video' ? 'any' : 0.5"></label>
            <button v-if="selectedScene.kind === 'video'" type="button" class="movie-full-clip" @click="fullClip(selectedScene)">{{ t('movie.fullClip') }}</button>
            <div class="movie-scene-actions"><button type="button" :disabled="selectedSceneIndex === 0" :aria-label="t('movie.up')" @click="move(selectedSceneIndex, -1)">↑</button><button type="button" :disabled="selectedSceneIndex === scenes.length - 1" :aria-label="t('movie.down')" @click="move(selectedSceneIndex, 1)">↓</button><button type="button" @click="remove(selectedSceneIndex)">{{ t('movie.remove') }}</button></div>
          </article>
          <p v-else class="movie-empty">{{ t('movie.selectMaterial') }}</p>
        </fieldset>
      </div>
    </div>
  </section>
</template>

<style scoped>
.is-recording .movie-preview { pointer-events:none; }
.movie-editor { width:100%; height:100%; min-height:0; min-width:0; overflow-y:auto; padding:0 4px 32px; container:movie / inline-size; scrollbar-width:thin; }
.movie-layout { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:24px; }
.movie-layout > div { min-width:0; }
.movie-controls,.movie-scenes,.movie-details { display:grid; gap:12px; border:0; padding:0; min-width:0; }
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
.movie-scenes legend,.movie-details legend { padding:0 0 12px; font-weight:600; }
.movie-material-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(min(130px,100%),1fr)); gap:10px; }
.movie-editor .movie-material { position:relative; display:flex; flex-direction:column; align-items:center; gap:10px; min-width:0; padding:18px 10px 12px; text-align:center; }
.movie-editor .movie-material.is-selected { border-color:var(--accent,#9691ff); background:color-mix(in srgb,var(--accent,#9691ff) 16%,var(--panel,#171923)); box-shadow:inset 0 0 0 1px var(--accent,#9691ff); }
.movie-material:focus-visible { outline:2px solid var(--accent,#9691ff); outline-offset:3px; }
.movie-material-number { position:absolute; top:6px; left:8px; font-size:12px; opacity:.7; }
.movie-material-icon { width:36px; height:36px; margin:8px 0; flex-shrink:0; }
.movie-material-name { width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.movie-material-meta { font-size:12px; opacity:.7; overflow-wrap:anywhere; }
.movie-details { margin-top:24px; }
.movie-source-preview { display:block; width:100%; max-height:240px; object-fit:contain; border-radius:8px; background:#10111b; }
.movie-scene { display:grid; gap:10px; padding:16px; border:1px solid #7775; border-radius:12px; }
.movie-scene strong { overflow-wrap:anywhere; }
.movie-scene-actions { display:flex; flex-wrap:wrap; gap:6px; }
.movie-preview { min-height:150px; background:#10111b; border-radius:12px; overflow:hidden; }
.movie-output h2 { margin-top:0; }
.movie-render { margin:12px 0; }
.movie-download { display:block; margin:12px 0; text-align:center; }
.movie-note,.movie-empty { opacity:.7; font-size:13px; line-height:1.6; }
@container movie (max-width:700px) { .movie-layout { grid-template-columns:minmax(0,1fr); } }
</style>
