<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue';
import { aspectRatioName } from '../domain/aspect-ratios';

const props = defineProps<{ modelValue: string; options: unknown[]; label?: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const trigger = ref<HTMLElement | null>(null);
const open = ref(false);
const position = ref({ left: 0, top: 0, width: 190, maxHeight: 340 });
const choices = computed(() => props.options.map(value => ({ value: String(value), name: aspectRatioName(value) })));

function place() {
  if (!trigger.value) return;
  const rect = trigger.value.getBoundingClientRect();
  const width = Math.max(190, rect.width);
  const desiredHeight = Math.min(340, choices.value.length * 54 + 12);
  const spaceAbove = rect.top - 10;
  const spaceBelow = window.innerHeight - rect.bottom - 10;
  const above = spaceAbove >= Math.min(desiredHeight, 220) || spaceAbove > spaceBelow;
  const maxHeight = Math.max(120, Math.min(desiredHeight, above ? spaceAbove : spaceBelow));
  position.value = {
    left: Math.max(10, Math.min(rect.left, window.innerWidth - width - 10)),
    top: above ? Math.max(10, rect.top - maxHeight - 8) : rect.bottom + 8,
    width,
    maxHeight,
  };
}

function show() {
  open.value = true;
  void nextTick(place);
  window.addEventListener('resize', place);
  window.addEventListener('scroll', place, true);
  document.addEventListener('pointerdown', outside);
  document.addEventListener('keydown', keydown);
}

function close() {
  open.value = false;
  window.removeEventListener('resize', place);
  window.removeEventListener('scroll', place, true);
  document.removeEventListener('pointerdown', outside);
  document.removeEventListener('keydown', keydown);
}

function outside(event: PointerEvent) {
  const target = event.target as Node;
  if (trigger.value?.contains(target) || (target instanceof Element && target.closest('.aspect-ratio-menu'))) return;
  close();
}

function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { close(); trigger.value?.focus(); }
}

function select(value: string) {
  emit('update:modelValue', value);
  close();
  trigger.value?.focus();
}

onBeforeUnmount(close);
</script>

<template>
  <div class="aspect-picker">
    <button ref="trigger" type="button" class="select-pill aspect-picker-trigger" aria-haspopup="listbox" :aria-expanded="open" @click="open ? close() : show()">
      <span class="aspect-ratio-icon" aria-hidden="true"></span>
      <span v-if="label" class="aspect-picker-label">{{ label }}</span>
      <strong>{{ modelValue }}</strong>
      <span class="aspect-picker-chevron" aria-hidden="true">⌄</span>
    </button>
    <select class="aspect-native-select" :value="modelValue" tabindex="-1" aria-hidden="true" @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)">
      <option v-for="choice in choices" :key="choice.value" :value="choice.value">{{ choice.value }}{{ choice.name ? ` — ${choice.name}` : '' }}</option>
    </select>
    <Teleport to="body">
      <div v-if="open" class="aspect-ratio-menu" role="listbox" :style="{ left: `${position.left}px`, top: `${position.top}px`, width: `${position.width}px`, maxHeight: `${position.maxHeight}px` }">
        <button v-for="choice in choices" :key="choice.value" type="button" role="option" :aria-selected="choice.value === modelValue" @click="select(choice.value)">
          <span class="aspect-ratio-icon" aria-hidden="true"></span>
          <span><strong>{{ choice.value }}</strong><small v-if="choice.name">{{ choice.name }}</small></span>
        </button>
      </div>
    </Teleport>
  </div>
</template>
