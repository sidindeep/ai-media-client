<script setup lang="ts">
import AppIcon from "./AppIcon.vue";
import { computed, useId, watch } from 'vue';
import AspectRatioPicker from './AspectRatioPicker.vue';
import DurationPicker from './DurationPicker.vue';
import ParameterPicker from './ParameterPicker.vue';
import type { MediaField } from '../types';
import { mediaFieldOptions } from '../domain/media-fields';
import { videoDurationOptions, videoPrimaryFields } from '../domain/video-settings';
import { useI18n } from '../i18n';

const props = defineProps<{ fields: MediaField[]; values: Record<string, unknown>; errors: Record<string, string>; expanded: boolean }>();
const emit = defineEmits<{ change: [field: MediaField, value: unknown]; 'update:expanded': [value: boolean] }>();
const { t } = useI18n();
const labelId = useId();
const primary = computed(() => videoPrimaryFields(props.fields));
const visibleSelectKinds = computed(() => (['aspect', 'quality'] as const).filter(kind => primary.value[kind]));
const durationOptions = computed(() => videoDurationOptions(primary.value.duration));
const durationChoices = computed(() => durationOptions.value.map(option => ({ value: String(option), label: durationLabel(option) })));
const value = (field: MediaField) => props.values[field.key] ?? field.default ?? field.apiDefault ?? '';
watch(() => [primary.value.duration, durationOptions.value, primary.value.duration && value(primary.value.duration)] as const, ([field, options, current]) => {
  if (!field || !options.length || options.some(option => String(option) === String(current))) return;
  if (Number(current) > 0 && String(current).trim().toLowerCase() !== 'auto') return;
  const fallback = options.find(option => String(option) === String(field.default ?? field.apiDefault)) ?? options[0];
  emit('change', field, fallback);
}, { immediate: true });
function change(field: MediaField, raw: string) {
  const option = mediaFieldOptions(field).find(item => String(item) === raw);
  emit('change', field, option ?? raw);
}
function optionLabel(field: MediaField, option: unknown) {
  return field.optionLabels?.[String(option)] || String(option);
}
function durationLabel(option: unknown) {
  const seconds = Number(option);
  return Number.isFinite(seconds) ? seconds <= 0 ? t('composer.auto')
    : t('common.seconds', { count: String(option) }) : String(option);
}
</script>

<template>
  <div class="video-settings-bar">
    <div class="video-setting video-model-setting"><span class="video-setting-label">{{ t('composer.video.model') }}</span><slot /></div>
    <div v-for="kind in visibleSelectKinds" :key="kind" class="video-setting" :class="{ invalid: primary[kind] && errors[primary[kind]!.key] }">
      <span :id="`${labelId}-${kind}`" class="video-setting-label">{{ t(kind === 'aspect' ? 'composer.video.aspect' : primary.quality?.key === 'quality' ? 'composer.unionField.quality' : 'composer.unionField.resolution') }}</span>
      <AspectRatioPicker v-if="kind === 'aspect' && primary.aspect && mediaFieldOptions(primary.aspect).length" compact :model-value="String(value(primary.aspect))" :options="mediaFieldOptions(primary.aspect)" :option-labels="primary.aspect.optionLabels" :accessible-label="t('composer.video.aspect')" @update:model-value="change(primary.aspect, $event)" />
      <ParameterPicker v-else-if="primary[kind] && mediaFieldOptions(primary[kind]!).length" :model-value="String(value(primary[kind]!))" :options="mediaFieldOptions(primary[kind]!).map(option => ({ value: String(option), label: optionLabel(primary[kind]!, option) }))" icon="resolution" :menu-icons="false" :accessible-label="t(primary.quality?.key === 'quality' ? 'composer.unionField.quality' : 'composer.unionField.resolution')" @update:model-value="change(primary[kind]!, $event)" />
      <span v-else class="video-setting-control">
        <AppIcon :name="kind === 'aspect' ? 'aspect-ratio' : 'resolution'" />
        <input v-if="primary[kind]" :aria-labelledby="`${labelId}-${kind}`" type="text" :value="value(primary[kind]!)" @change="change(primary[kind]!, ($event.target as HTMLInputElement).value)" />
        <span v-else class="video-setting-unavailable" :title="t('composer.video.unavailable')">—</span>
      </span>
      <small v-if="primary[kind] && errors[primary[kind]!.key]" class="field-error">{{ errors[primary[kind]!.key] }}</small>
    </div>
    <div v-if="primary.duration" class="video-setting video-duration-setting" :class="{ invalid: errors[primary.duration.key] }">
      <span class="video-setting-label">{{ t('composer.video.duration') }}</span>
      <DurationPicker v-if="durationOptions.length" :model-value="String(value(primary.duration))" :label="t('composer.video.duration')" :options="durationChoices" @update:model-value="change(primary.duration, $event)" />
      <span v-else class="video-setting-control">
        <AppIcon name="duration" />
        <input :type="primary.duration.type === 'number' ? 'number' : 'text'" :value="value(primary.duration)" :min="primary.duration.min ?? primary.duration.schema?.minimum as number" :max="primary.duration.max ?? primary.duration.schema?.maximum as number" :step="primary.duration.step || 'any'" @input="change(primary.duration, ($event.target as HTMLInputElement).value)" />
      </span>
      <small v-if="errors[primary.duration.key]" class="field-error">{{ errors[primary.duration.key] }}</small>
    </div>
    <button type="button" class="video-settings-toggle" :title="t('composer.advanced')" :aria-label="t('composer.advanced')" :aria-expanded="expanded" aria-controls="video-advanced-settings" @click="emit('update:expanded', !expanded)">
      <AppIcon name="settings" />
    </button>
  </div>
</template>
