<script setup lang="ts">
import ParameterPicker from './ParameterPicker.vue';

defineProps<{ modelValue: string; options: Array<{ value: string; label: string }>; label: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
</script>

<template>
  <ParameterPicker class="duration-picker" :model-value="modelValue" :options="options" :accessible-label="label" icon="duration" :menu-icons="false" @update:model-value="emit('update:modelValue', $event)" />
</template>
