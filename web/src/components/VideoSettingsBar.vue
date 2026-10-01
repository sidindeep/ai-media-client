<script setup lang="ts">
import { computed, watch } from 'vue';
import DurationPicker from './DurationPicker.vue';
import type { MediaField } from '../types';
import { mediaFieldOptions } from '../domain/media-fields';
import { videoDurationOptions, videoPrimaryFields } from '../domain/video-settings';
import { useI18n } from '../i18n';

const props = defineProps<{ fields: MediaField[]; values: Record<string, unknown>; errors: Record<string, string>; expanded: boolean }>();
const emit = defineEmits<{ change: [field: MediaField, value: unknown]; 'update:expanded': [value: boolean] }>();
const { t } = useI18n();
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
function durationLabel(option: unknown) {
  const seconds = Number(option);
  return Number.isFinite(seconds) ? seconds <= 0 ? t('composer.auto')
    : t('common.seconds', { count: String(option) }) : String(option);
}
</script>

<template>
  <div class="video-settings-bar">
    <div class="video-setting video-model-setting"><span class="video-setting-label">{{ t('composer.video.model') }}</span><slot /></div>
    <label v-for="kind in visibleSelectKinds" :key="kind" class="video-setting" :class="{ invalid: primary[kind] && errors[primary[kind]!.key] }">
      <span class="video-setting-label">{{ t(kind === 'aspect' ? 'composer.video.aspect' : primary.quality?.key === 'quality' ? 'composer.unionField.quality' : 'composer.unionField.resolution') }}</span>
      <select v-if="primary[kind] && mediaFieldOptions(primary[kind]!).length" :value="value(primary[kind]!)" @change="change(primary[kind]!, ($event.target as HTMLSelectElement).value)">
        <option v-for="option in mediaFieldOptions(primary[kind]!)" :key="String(option)" :value="String(option)">{{ option }}</option>
      </select>
      <input v-else-if="primary[kind]" type="text" :value="value(primary[kind]!)" @change="change(primary[kind]!, ($event.target as HTMLInputElement).value)" />
      <span v-else class="video-setting-unavailable" :title="t('composer.video.unavailable')">—</span>
      <small v-if="primary[kind] && errors[primary[kind]!.key]" class="field-error">{{ errors[primary[kind]!.key] }}</small>
    </label>
    <div class="video-setting video-duration-setting" :class="{ invalid: primary.duration && errors[primary.duration.key] }">
      <span class="video-setting-label">{{ t('composer.video.duration') }}</span>
      <DurationPicker v-if="primary.duration && durationOptions.length" :model-value="String(value(primary.duration))" :label="t('composer.video.duration')" :options="durationChoices" @update:model-value="change(primary.duration!, $event)" />
      <input v-else-if="primary.duration" :type="primary.duration.type === 'number' ? 'number' : 'text'" :value="value(primary.duration)" :min="primary.duration.min ?? primary.duration.schema?.minimum as number" :max="primary.duration.max ?? primary.duration.schema?.maximum as number" :step="primary.duration.step || 'any'" @input="change(primary.duration, ($event.target as HTMLInputElement).value)" />
      <span v-else class="video-setting-unavailable" :title="t('composer.video.unavailable')">—</span>
      <small v-if="primary.duration && errors[primary.duration.key]" class="field-error">{{ errors[primary.duration.key] }}</small>
    </div>
    <button type="button" class="video-settings-toggle" :title="t('composer.advanced')" :aria-label="t('composer.advanced')" :aria-expanded="expanded" aria-controls="video-advanced-settings" @click="emit('update:expanded', !expanded)">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m9 3-.6 2.2-1.8 1L4.4 6 2.9 8.6l1.6 1.7v2.1l-1.6 1.7 1.5 2.6 2.2-.3 1.8 1L9 20h3l.6-2.6 1.8-1 2.2.3 1.5-2.6-1.6-1.7v-2.1l1.6-1.7L16.6 6l-2.2.2-1.8-1L12 3Z" transform="translate(1.5 .5)"/><circle cx="12" cy="12" r="3"/></svg>
    </button>
  </div>
</template>
