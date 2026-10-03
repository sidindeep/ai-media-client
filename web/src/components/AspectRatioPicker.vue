<script setup lang="ts">
import { computed } from 'vue';
import ParameterPicker from './ParameterPicker.vue';
import AspectRatioIcon from './AspectRatioIcon.vue';
import { aspectRatioName } from '../domain/aspect-ratios';

const props = defineProps<{ modelValue: string; options: unknown[]; label?: string; accessibleLabel?: string; optionLabels?: Record<string, string>; compact?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const choices = computed(() => props.options.map(value => ({ value: String(value), label: props.optionLabels?.[String(value)] || String(value), description: aspectRatioName(value) })));
</script>

<template>
  <ParameterPicker class="aspect-picker" :model-value="modelValue" :options="choices" :label="compact ? undefined : label" :accessible-label="accessibleLabel || label" :menu-icons="true" native-class="aspect-native-select" @update:model-value="emit('update:modelValue', $event)">
    <template #icon="{ value }"><AspectRatioIcon :value="value" /></template>
  </ParameterPicker>
</template>
