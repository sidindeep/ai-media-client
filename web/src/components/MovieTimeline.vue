<script setup lang="ts">
import { computed, ref } from 'vue';
import { FPS, timeline, type Scene, type MusicEditing } from '../remotion/model.mjs';
import { useI18n } from '../i18n';
const props = defineProps<{ scenes: Scene[]; selected: string; frame: number; disabled: boolean; music: string; musicSettings: MusicEditing; muteClips: boolean }>();
const emit = defineEmits<{ select: [id: string]; seek: [frame: number]; reorder: [id: string, target: string] }>();
const { t } = useI18n();
const zoom = ref(1);
const dragged = ref('');
const plan = computed(() => { try { return timeline(props.scenes); } catch { return null; } });
const duration = computed(() => plan.value?.durationInFrames || 1);
const musicDuration = computed(() => Math.min(duration.value - Math.round(props.musicSettings.start * FPS), props.musicSettings.sourceDuration === undefined ? Infinity : Math.round((props.musicSettings.sourceDuration - props.musicSettings.trimStart) * FPS)));
const percent = (frames: number) => `${frames / duration.value * 100}%`;
const bar = (from: number, frames: number) => ({ left: percent(from), width: percent(frames) });
function choose(id: string, frame: number) { emit('select', id); emit('seek', frame); }
function drop(target: string) { if (!props.disabled && dragged.value) emit('reorder', dragged.value, target); dragged.value = ''; }
</script>

<template>
  <fieldset class="movie-timeline" :disabled="disabled || !plan">
    <legend>{{ t('movie.timeline') }}</legend>
    <div class="timeline-toolbar">
      <label>{{ t('movie.playhead') }} · {{ (frame / FPS).toFixed(2) }} {{ t('movie.secondsShort') }}
        <input class="movie-playhead" type="range" :value="frame" min="0" :max="duration - 1" step="1" @input="emit('seek', Number(($event.target as HTMLInputElement).value))">
      </label>
      <label>{{ t('movie.timelineZoom') }}<input v-model.number="zoom" type="range" min="1" max="5" step="0.5"></label>
    </div>
    <p class="timeline-help">{{ t('movie.timelineHelp') }}</p>
    <div class="timeline-scroll">
      <div class="timeline-content" :style="{ width: `${zoom * 100}%` }">
        <div class="timeline-ruler"><span>0</span><span>{{ (duration / FPS / 2).toFixed(1) }}</span><span>{{ (duration / FPS).toFixed(1) }} s</span></div>
        <div class="timeline-track"><span class="track-label">{{ t('movie.pictureTrack') }}</span>
          <button v-for="(scene, index) in plan?.scenes" :key="scene.id" class="timeline-clip" :class="{ selected: scene.id === selected }" :style="bar(scene.from, scene.durationInFrames)"
            :title="`${index + 1}. ${scene.name || scene.title} · ${(scene.from / FPS).toFixed(2)} s`" :aria-pressed="scene.id === selected" type="button" :draggable="!disabled"
            @dragstart="dragged = scene.id" @dragend="dragged = ''" @dragover.prevent @drop.prevent="drop(scene.id)" @click="choose(scene.id, scene.from)">
            {{ index + 1 }} · {{ scene.name || scene.title || t('movie.title') }}
          </button>
          <span class="playhead-line" :style="{ left: percent(frame) }"></span>
        </div>
        <div class="timeline-track captions-track"><span class="track-label">{{ t('movie.caption') }}</span>
          <template v-for="scene in plan?.scenes" :key="scene.id">
            <button v-if="scene.title && scene.captionEnd > scene.captionStart" type="button" class="timeline-clip" :style="bar(scene.from + Math.round(scene.captionStart * FPS), Math.round((scene.captionEnd - scene.captionStart) * FPS))" @click="choose(scene.id, scene.from + Math.round(scene.captionStart * FPS))">{{ scene.title }}</button>
          </template>
          <span class="playhead-line" :style="{ left: percent(frame) }"></span>
        </div>
        <div class="timeline-track audio-track"><span class="track-label">{{ t('movie.clipAudio') }}</span>
          <template v-for="scene in plan?.scenes" :key="scene.id">
            <button v-if="scene.kind === 'video'" type="button" class="timeline-clip" :class="{ muted: muteClips || !scene.volume }" :style="bar(scene.from, scene.durationInFrames)" @click="choose(scene.id, scene.from)">{{ Math.round((muteClips ? 0 : scene.volume) * 100) }}%</button>
          </template>
          <span class="playhead-line" :style="{ left: percent(frame) }"></span>
        </div>
        <div v-if="music" class="timeline-track music-track"><span class="track-label">{{ t('movie.music') }}</span>
          <button v-if="musicDuration > 0" type="button" class="timeline-clip" :style="bar(Math.round(musicSettings.start * FPS), musicDuration)" @click="emit('seek', Math.round(musicSettings.start * FPS))">{{ t('movie.music') }} · {{ Math.round(musicSettings.volume * 100) }}%</button>
          <span class="playhead-line" :style="{ left: percent(frame) }"></span>
        </div>
      </div>
    </div>
  </fieldset>
</template>

<style scoped>
.movie-timeline { border:1px solid #7775; border-radius:12px; min-width:0; padding:14px; margin:22px 0 0; }
legend { font-weight:600; }
.timeline-toolbar { display:flex; flex-wrap:wrap; gap:16px; }
.timeline-toolbar label { display:grid; gap:6px; flex:1; min-width:120px; }
input { width:100%; }
.timeline-help { font-size:12px; opacity:.7; }
.timeline-scroll { overflow-x:auto; padding-bottom:8px; }
.timeline-content { min-width:100%; }
.timeline-ruler { display:flex; justify-content:space-between; font-size:11px; opacity:.7; }
.timeline-track { position:relative; height:64px; margin:5px 0; border-radius:6px; background:#7771; overflow:hidden; }
.track-label { position:absolute; top:2px; left:4px; opacity:.6; font-size:10px; pointer-events:none; }
.timeline-clip { position:absolute; top:21px; height:36px; min-width:2px; padding:4px; border:1px solid #a49aff; border-radius:5px; background:#353052; color:inherit; text-align:left; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; cursor:pointer; }
.timeline-clip.selected { outline:2px solid #c6beff; outline-offset:-2px; background:#544780; }
.captions-track .timeline-clip { background:#58402d; border-color:#d3a16c; }
.audio-track .timeline-clip,.music-track .timeline-clip { background:#244f44; border-color:#65b9a1; }
.timeline-clip.muted { opacity:.4; }
.playhead-line { position:absolute; top:0; bottom:0; width:2px; background:#ffcf72; pointer-events:none; }
button:disabled { opacity:.4; cursor:default; }
</style>
