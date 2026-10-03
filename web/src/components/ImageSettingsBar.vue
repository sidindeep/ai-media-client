<script setup lang="ts">
import { useId } from 'vue';
import AppIcon from './AppIcon.vue';
import AspectRatioPicker from './AspectRatioPicker.vue';
import ParameterPicker from './ParameterPicker.vue';
import type { MediaField } from '../types';
import { mediaFieldOptions } from '../domain/media-fields';
import { parameterIcon } from '../domain/image-settings';
import { useI18n } from '../i18n';

const props = defineProps<{ fields: MediaField[]; values: Record<string, unknown>; errors: Record<string, string>; expanded: boolean; allowDefault?: boolean; showAdvanced?: boolean }>();
const emit = defineEmits<{ change: [field: MediaField, value: unknown]; 'update:expanded': [value: boolean] }>();
const { t } = useI18n();
const labelId = useId();
const value = (field: MediaField) => props.values[field.key] ?? (props.allowDefault ? '' : field.default ?? field.apiDefault ?? '');
function options(field: MediaField) {
  return props.allowDefault ? ['', ...mediaFieldOptions(field)] : mediaFieldOptions(field);
}
function optionLabel(field: MediaField, option: unknown) {
  return option === '' && props.allowDefault ? t('common.default') : field.optionLabels?.[String(option)] || String(option);
}
function change(field: MediaField, raw: string) {
  emit('change', field, mediaFieldOptions(field).find(option => String(option) === raw) ?? raw);
}
</script>

<template>
  <div class="video-settings-bar image-settings-bar">
    <div class="video-setting video-model-setting"><span class="video-setting-label">{{ t('composer.video.model') }}</span><slot /></div>
    <div v-for="field in fields" :key="field.key" class="video-setting" :class="{ invalid: errors[field.key] }">
      <span :id="`${labelId}-${field.key}`" class="video-setting-label">{{ field.label || field.key }}{{ field.required ? ' *' : '' }}</span>
      <AspectRatioPicker v-if="parameterIcon(field) === 'aspect-ratio'" compact :model-value="String(value(field))" :options="options(field)" :option-labels="allowDefault ? { ...field.optionLabels, '': t('common.default') } : field.optionLabels" :accessible-label="field.label || t('composer.format')" @update:model-value="change(field, $event)" />
      <ParameterPicker v-else :model-value="String(value(field))" :options="options(field).map(option => ({ value: String(option), label: optionLabel(field, option) }))" :icon="parameterIcon(field)" :menu-icons="!['resolution', 'duration'].includes(parameterIcon(field) || '')" :accessible-label="field.label || field.key" @update:model-value="change(field, $event)" />
      <small v-if="errors[field.key]" class="field-error">{{ errors[field.key] }}</small>
    </div>
    <button v-if="showAdvanced" type="button" class="video-settings-toggle" :title="t('composer.advanced')" :aria-label="t('composer.advanced')" :aria-expanded="expanded" aria-controls="image-advanced-settings" @click="emit('update:expanded', !expanded)">
      <AppIcon name="settings" />
    </button>
  </div>
</template>
