<script setup lang="ts">
defineProps<{
  modelValue: 'codex' | 'media';
  mediaLabel: string;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: 'codex' | 'media'] }>();
</script>

<template>
  <div class="provider-selector" role="group" aria-label="Провайдер генерации">
    <button type="button" :class="{ active: modelValue === 'codex' }" data-provider="codex" @click="emit('update:modelValue', 'codex')">
      <span>Codex CLI</span><small>GPT · текст и изображения</small>
    </button>
    <button type="button" :class="{ active: modelValue === 'media' }" data-provider="media" @click="emit('update:modelValue', 'media')">
      <span>{{ mediaLabel }}</span><small>Изображения и видео</small>
    </button>
  </div>
</template>
