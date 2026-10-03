<script setup lang="ts">
import { computed } from 'vue';
import AppIcon from './AppIcon.vue';
import { aspectRatioFrame } from '../domain/aspect-ratios';

const props = defineProps<{ value: unknown }>();
const frame = computed(() => aspectRatioFrame(props.value));
</script>

<template>
  <svg v-if="frame" class="app-icon aspect-frame-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <rect v-bind="frame" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5" />
  </svg>
  <AppIcon v-else name="fullscreen" class="aspect-frame-icon" />
</template>
