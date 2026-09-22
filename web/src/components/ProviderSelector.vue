<script setup lang="ts">
import { useI18n } from '../i18n';

defineProps<{
  modelValue: 'codex' | 'media';
  mediaLabel: string;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: 'codex' | 'media'] }>();
const { t } = useI18n();
</script>

<template>
  <div class="provider-selector" role="group" :aria-label="t('provider.aria')">
    <button type="button" :class="{ active: modelValue === 'codex' }" data-provider="codex" @click="emit('update:modelValue', 'codex')">
      <span>Codex CLI</span><small>{{ t('provider.codexDetail') }}</small>
    </button>
    <button type="button" :class="{ active: modelValue === 'media' }" data-provider="media" @click="emit('update:modelValue', 'media')">
      <span>{{ mediaLabel }}</span><small>{{ t('provider.mediaDetail') }}</small>
    </button>
  </div>
</template>
