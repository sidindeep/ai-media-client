<script setup lang="ts">
import { iconHref, type IconName } from '../icons';

defineProps<{ name: IconName }>();
</script>

<template>
  <svg class="app-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><use :href="iconHref(name)" /></svg>
</template>
