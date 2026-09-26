<script setup lang="ts">
import type { MediaField } from '../types';
import { useI18n } from '../i18n';

defineProps<{ fields: [MediaField, MediaField] }>();
const emit = defineEmits<{ selected: [files: File[], field: MediaField] }>();
const { t } = useI18n();

function selectFiles(event: Event, field: MediaField) {
  const input = event.target as HTMLInputElement;
  emit('selected', [...(input.files || [])], field);
  input.value = '';
}
</script>

<template>
  <label v-for="(field, index) in fields" :key="field.key" class="attach-button">
    ＋ {{ t(index === 0 ? 'composer.frame.first' : 'composer.frame.last') }}{{ field.required ? ' *' : '' }}
    <input type="file" :accept="field.accept" :multiple="!field.scalar && field.maxFiles !== 1" @change="selectFiles($event, field)" />
  </label>
</template>
