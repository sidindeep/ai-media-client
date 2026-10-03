<script setup lang="ts">
import AppIcon from "./AppIcon.vue";
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = defineProps<{ kind: string; src?: string }>();
const root = ref<HTMLElement>();
const visible = ref(false);
const thumbnail = ref('');
const failed = ref(false);
const loading = ref(false);
let observer: IntersectionObserver | undefined;

watch(() => [props.kind, props.src, visible.value] as const, ([kind, src, isVisible], _, onCleanup) => {
  thumbnail.value = ''; failed.value = false; loading.value = false;
  if (!isVisible || !src || !['image', 'video'].includes(kind)) return;
  loading.value = true;
  if (kind === 'image') {
    thumbnail.value = src;
    const timeout = setTimeout(() => { if (loading.value) { failed.value = true; loading.value = false; } }, 15000);
    onCleanup(() => clearTimeout(timeout));
    return;
  }

  // Decode one small still, then release the video and its network/decoder resources.
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.preload = 'auto';
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const stop = () => {
    if (stopped) return;
    stopped = true; clearTimeout(timer);
    video.onloadedmetadata = video.onloadeddata = video.onseeked = video.onerror = null;
    video.pause(); video.removeAttribute('src'); video.load();
  };
  const fail = () => { failed.value = true; loading.value = false; stop(); };
  const capture = () => {
    if (stopped || video.readyState < 2 || !video.videoWidth) return;
    try {
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 320 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) { fail(); return; }
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      thumbnail.value = canvas.toDataURL('image/jpeg', 0.75);
      stop();
    } catch { fail(); }
  };
  video.onloadedmetadata = () => {
    if (Number.isFinite(video.duration) && video.duration > 0.1) video.currentTime = Math.min(0.1, video.duration / 2);
  };
  video.onloadeddata = () => { if (!video.seeking) capture(); };
  video.onseeked = capture;
  video.onerror = fail;
  timer = setTimeout(fail, 15000);
  onCleanup(stop);
  video.src = src;
}, { immediate: true });

onMounted(() => {
  observer = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) {
      visible.value = true; observer?.disconnect();
    }
  }, { rootMargin: '200px' });
  if (root.value) observer.observe(root.value);
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <span ref="root" class="movie-material-thumbnail" :class="{ 'has-thumbnail': thumbnail && !failed }" :aria-busy="loading">
    <img v-if="thumbnail && !failed" v-show="!loading" :src="thumbnail" alt="" decoding="async" @load="loading = false" @error="failed = true; loading = false">
    <slot v-else-if="!loading" />
    <span v-if="loading" class="movie-thumbnail-spinner" aria-hidden="true"></span>
    <AppIcon v-if="kind === 'video' && thumbnail && !failed && !loading" class="movie-thumbnail-play" name="play" />
  </span>
</template>

<style scoped>
.movie-material-thumbnail { position:relative; display:flex; justify-content:center; align-items:center; width:100%; aspect-ratio:16/10; overflow:hidden; border-radius:6px; }
.has-thumbnail { background:#10111b; }
.movie-material-thumbnail img { width:100%; height:100%; object-fit:cover; }
.movie-thumbnail-play { position:absolute; right:5px; bottom:5px; width:22px; height:22px; color:white; background:#0009; border-radius:50%; }
.movie-thumbnail-spinner { position:absolute; width:28px; height:28px; border:3px solid #a796ff33; border-top-color:#a796ff; border-radius:50%; animation:movie-thumbnail-spin .8s linear infinite; }
@keyframes movie-thumbnail-spin { to { transform:rotate(360deg); } }
</style>
