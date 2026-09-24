<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from '../i18n';

const props = defineProps<{ src: string; downloadUrl: string; alt: string }>();
const { t } = useI18n();
const thumbnail = ref<HTMLImageElement | null>(null);
const dialog = ref<HTMLDialogElement | null>(null);

function open() { dialog.value?.showModal(); }
function close() { dialog.value?.close(); }
function restoreFocus() { thumbnail.value?.focus(); }
watch(() => props.src, close);
</script>

<template>
  <img ref="thumbnail" class="expandable-result-image" :src="src" :alt="alt" role="button" tabindex="0"
    :aria-label="t('result.expandImage')" @click.stop="open" @keydown.enter.stop.prevent="open" @keydown.space.stop.prevent="open">
  <Teleport to="body">
    <dialog ref="dialog" class="result-image-lightbox" :aria-label="t('result.expandedImage')" @click.self="close" @close="restoreFocus">
      <div class="result-image-lightbox-toolbar">
        <a class="result-image-lightbox-download" :href="downloadUrl" download>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 17v3h16v-3" /></svg>
          {{ t('common.download') }}
        </a>
        <button type="button" class="result-image-lightbox-close" :aria-label="t('common.close')" @click="close">×</button>
      </div>
      <img class="result-image-lightbox-image" :src="src" :alt="alt">
    </dialog>
  </Teleport>
</template>
