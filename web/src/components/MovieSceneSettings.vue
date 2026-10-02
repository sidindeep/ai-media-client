<script setup lang="ts">
import { computed } from 'vue';
import { FPS, sceneEditing, type Scene } from '../remotion/model.mjs';
import { useI18n } from '../i18n';
import limits from '../../../config/movie-editor.json';
const props = defineProps<{ scene: Scene; frame: number; from: number; canSplit: boolean }>();
const emit = defineEmits<{ patch: [value: Partial<Scene>]; trim: [start: number, end: number]; split: []; seek: [] }>();
const { t } = useI18n();
const editing = computed(() => { try { return sceneEditing(props.scene); } catch { return sceneEditing({ ...props.scene, captionStart: 0, captionEnd: props.scene.seconds, sourceDuration: undefined }); } });
const end = computed(() => (props.scene.trimStart || 0) + props.scene.seconds);
const value = (event: Event) => (event.target as HTMLInputElement).value;
const numeric = (event: Event) => Number(value(event));
function numberPatch(key: keyof Scene, event: Event) { emit('patch', { [key]: numeric(event) }); }
</script>

<template>
  <div class="movie-edit-settings">
    <button type="button" class="movie-seek-scene" @click="emit('seek')">{{ t('movie.seekScene') }}</button>
    <div v-if="scene.kind === 'video'" class="setting-group">
      <strong>{{ t('movie.trim') }}</strong>
      <label>{{ t('movie.trimStart') }}<input class="movie-trim-start" type="number" :value="editing.trimStart" min="0" :max="end - 1 / FPS" :step="1 / FPS" @change="emit('trim', numeric($event), end)"></label>
      <label>{{ t('movie.trimEnd') }}<input class="movie-trim-end" type="number" :value="end" :min="editing.trimStart + 1 / FPS" :max="scene.sourceDuration || limits.maxSeconds" :step="1 / FPS" @change="emit('trim', editing.trimStart, numeric($event))"></label>
      <button type="button" class="movie-split" :disabled="!canSplit" @click="emit('split')">{{ t('movie.split') }} · {{ ((frame - from) / FPS).toFixed(2) }} s</button>
      <strong>{{ t('movie.clipAudio') }}</strong>
      <label>{{ t('movie.volume') }} · {{ Math.round(editing.volume * 100) }}%<input class="movie-clip-volume" type="range" :value="editing.volume" min="0" max="1" step="0.01" @input="numberPatch('volume', $event)"></label>
      <label>{{ t('movie.audioFadeIn') }}<input type="number" :value="editing.audioFadeIn" min="0" :max="limits.editing.maxFadeSeconds" step="0.1" @change="numberPatch('audioFadeIn', $event)"></label>
      <label>{{ t('movie.audioFadeOut') }}<input type="number" :value="editing.audioFadeOut" min="0" :max="limits.editing.maxFadeSeconds" step="0.1" @change="numberPatch('audioFadeOut', $event)"></label>
    </div>
    <div v-if="scene.kind !== 'title'" class="setting-group">
      <strong>{{ t('movie.framing') }}</strong>
      <label>{{ t('movie.fit') }}<select class="movie-fit" :value="editing.fit" @change="emit('patch', { fit: value($event) as Scene['fit'] })"><option value="contain">{{ t('movie.contain') }}</option><option value="cover">{{ t('movie.cover') }}</option></select></label>
      <label>{{ t('movie.scale') }} · {{ editing.scale.toFixed(2) }}×<input class="movie-scale" type="range" :value="editing.scale" min="1" :max="limits.editing.maxScale" step="0.01" @input="numberPatch('scale', $event)"></label>
      <label>{{ t('movie.offsetX') }}<input class="movie-offset-x" type="range" :value="editing.offsetX" :min="-limits.editing.maxOffset" :max="limits.editing.maxOffset" @input="numberPatch('offsetX', $event)"></label>
      <label>{{ t('movie.offsetY') }}<input type="range" :value="editing.offsetY" :min="-limits.editing.maxOffset" :max="limits.editing.maxOffset" @input="numberPatch('offsetY', $event)"></label>
      <label v-if="scene.kind === 'image'">{{ t('movie.motion') }}<select class="movie-motion" :value="editing.motion" @change="emit('patch', { motion: value($event) as Scene['motion'] })"><option value="none">{{ t('movie.motionNone') }}</option><option value="zoom-in">{{ t('movie.zoomIn') }}</option><option value="zoom-out">{{ t('movie.zoomOut') }}</option></select></label>
      <button type="button" @click="emit('patch', { fit: 'contain', scale: 1, offsetX: 0, offsetY: 0, motion: 'none' })">{{ t('movie.resetFraming') }}</button>
    </div>
    <div class="setting-group">
      <strong>{{ t('movie.transition') }}</strong>
      <select class="movie-transition" :aria-label="t('movie.transition')" :value="editing.transition" @change="emit('patch', { transition: value($event) as Scene['transition'] })"><option value="cut">{{ t('movie.cut') }}</option><option value="fade">{{ t('movie.fade') }}</option><option value="slide">{{ t('movie.slide') }}</option></select>
      <label v-if="editing.transition !== 'cut'">{{ t('movie.transitionDuration') }}<input class="movie-transition-seconds" type="number" :value="editing.transitionSeconds" min="0" :max="limits.editing.maxTransitionSeconds" step="0.1" @change="numberPatch('transitionSeconds', $event)"></label>
      <p>{{ t('movie.transitionHelp') }}</p>
    </div>
    <div v-if="scene.title" class="setting-group">
      <strong>{{ t('movie.textSettings') }}</strong>
      <label>{{ t('movie.captionStart') }}<input class="movie-caption-start" type="number" :value="editing.captionStart" min="0" :max="editing.captionEnd" step="0.1" @change="numberPatch('captionStart', $event)"></label>
      <label>{{ t('movie.captionEnd') }}<input class="movie-caption-end" type="number" :value="editing.captionEnd" :min="editing.captionStart" :max="scene.seconds" step="0.1" @change="numberPatch('captionEnd', $event)"></label>
      <label>{{ t('movie.captionPosition') }}<select :value="editing.captionPosition" @change="emit('patch', { captionPosition: value($event) as Scene['captionPosition'] })"><option value="top">{{ t('movie.top') }}</option><option value="center">{{ t('movie.center') }}</option><option value="bottom">{{ t('movie.bottom') }}</option></select></label>
      <label>{{ t('movie.captionSize') }}<input type="number" :value="editing.captionSize" :min="limits.editing.minCaptionSize" :max="limits.editing.maxCaptionSize" @change="numberPatch('captionSize', $event)"></label>
      <label>{{ t('movie.captionColor') }}<input type="color" :value="editing.captionColor" @input="emit('patch', { captionColor: value($event) })"></label>
      <label>{{ t('movie.captionBackground') }}<input type="color" :value="editing.captionBackground" @input="emit('patch', { captionBackground: value($event) })"></label>
    </div>
  </div>
</template>

<style scoped>
.movie-edit-settings,.setting-group { display:grid; gap:10px; min-width:0; }
.setting-group { border-top:1px solid #7773; padding-top:14px; }
label { display:grid; gap:6px; }
input,select { width:100%; min-width:0; }
input[type=number],select { padding:10px; border:1px solid #7775; border-radius:8px; background:var(--panel,#171923); color:inherit; }
button { padding:10px; border:1px solid #7775; border-radius:8px; background:var(--panel,#242338); color:inherit; cursor:pointer; }
button:disabled { opacity:.4; cursor:default; }
p { font-size:12px; opacity:.7; margin:0; }
</style>
