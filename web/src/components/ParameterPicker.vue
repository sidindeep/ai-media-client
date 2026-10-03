<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
import AppIcon from './AppIcon.vue';
import type { IconName } from '../icons';

const props = withDefaults(defineProps<{
  modelValue: string;
  options: Array<{ value: string; label: string; description?: string }>;
  label?: string;
  accessibleLabel?: string;
  icon?: IconName;
  menuIcons?: boolean;
  nativeClass?: string;
}>(), { menuIcons: true });
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const trigger = ref<HTMLButtonElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const open = ref(false);
const active = ref(0);
const keyboardNavigation = ref(false);
const menuId = useId();
const selected = computed(() => props.options.find(option => option.value === props.modelValue));
const selectedLabel = computed(() => selected.value?.label ?? props.modelValue);
const position = ref({ left: 0, top: 0, maxHeight: 340 });

function place(event?: Event) {
  if (event && menu.value?.contains(event.target as Node)) return;
  if (!trigger.value) return;
  const rect = trigger.value.getBoundingClientRect();
  const width = menu.value?.getBoundingClientRect().width ?? 88;
  const desired = Math.min(340, props.options.length * 34 + 14);
  const aboveSpace = Math.max(0, rect.top - 18);
  const belowSpace = Math.max(0, window.innerHeight - rect.bottom - 18);
  const above = aboveSpace >= desired || aboveSpace > belowSpace;
  const maxHeight = Math.max(48, Math.min(desired, above ? aboveSpace : belowSpace));
  position.value = { left: Math.max(10, Math.min(rect.left, window.innerWidth - width - 10)),
    top: above ? Math.max(10, rect.top - maxHeight - 8) : rect.bottom + 8, maxHeight };
}
function reveal() {
  menu.value?.querySelector<HTMLElement>(`[data-index="${active.value}"]`)?.scrollIntoView({ block: 'nearest' });
}
async function show(fromKeyboard = false) {
  if (open.value || !props.options.length) return;
  active.value = Math.max(0, props.options.findIndex(option => option.value === props.modelValue));
  keyboardNavigation.value = fromKeyboard;
  open.value = true;
  window.addEventListener('resize', place);
  window.addEventListener('scroll', place, true);
  document.addEventListener('pointerdown', outside);
  await nextTick();
  place();
  await nextTick();
  place();
  menu.value?.focus({ preventScroll: true });
  reveal();
}
function close() {
  open.value = false;
  window.removeEventListener('resize', place);
  window.removeEventListener('scroll', place, true);
  document.removeEventListener('pointerdown', outside);
}
function outside(event: PointerEvent) {
  const target = event.target as Node;
  if (!trigger.value?.contains(target) && !menu.value?.contains(target)) close();
}
function choose(value: string) {
  emit('update:modelValue', value);
  close();
  trigger.value?.focus();
}
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape' || event.key === 'Tab') {
    close(); trigger.value?.focus();
    if (event.key === 'Escape') event.preventDefault();
    return;
  }
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    const option = props.options[active.value];
    if (option) choose(option.value);
    return;
  }
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  keyboardNavigation.value = true;
  active.value = event.key === 'Home' ? 0 : event.key === 'End' ? props.options.length - 1
    : Math.max(0, Math.min(props.options.length - 1, active.value + (event.key === 'ArrowDown' ? 1 : -1)));
  void nextTick(reveal);
}
watch(() => JSON.stringify(props.options.map(option => option.value)), close);
onBeforeUnmount(close);
</script>

<template>
  <div class="parameter-picker">
    <button ref="trigger" type="button" class="parameter-picker-trigger" aria-haspopup="listbox" :aria-expanded="open" :aria-controls="menuId" :aria-label="`${accessibleLabel || label || ''}: ${selectedLabel}`" @click="open ? close() : show()" @keydown.down.prevent="show(true)" @keydown.up.prevent="show(true)">
      <span v-if="icon || $slots.icon" class="parameter-picker-icon"><slot name="icon" :value="modelValue"><AppIcon v-if="icon" :name="icon" /></slot></span>
      <span v-if="label" class="parameter-picker-label">{{ label }}</span>
      <strong>{{ selectedLabel }}</strong>
      <AppIcon name="chevron-down" class="parameter-picker-chevron" />
    </button>
    <select class="parameter-native-select" :class="nativeClass" :value="modelValue" tabindex="-1" aria-hidden="true" @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)">
      <option v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</option>
    </select>
    <Teleport to="body">
      <div v-if="open" :id="menuId" ref="menu" class="parameter-picker-menu" :class="{ 'without-icons': menuIcons === false || !(icon || $slots.icon) }" role="listbox" tabindex="0" :aria-label="accessibleLabel || label" :aria-activedescendant="`${menuId}-${active}`" :style="{ left: `${position.left}px`, top: `${position.top}px`, maxHeight: `${position.maxHeight}px` }" @keydown="keydown" @pointermove="keyboardNavigation = false">
        <button v-for="(option, index) in options" :id="`${menuId}-${index}`" :key="option.value" type="button" role="option" tabindex="-1" :data-index="index" :class="{ 'is-active': keyboardNavigation && index === active }" :aria-selected="option.value === modelValue" :aria-label="option.description ? `${option.label} — ${option.description}` : option.label" @click="choose(option.value)">
          <span class="parameter-picker-check-slot">
            <!-- Iconoir check geometry stays mounted and does not depend on an external SVG use. -->
            <svg v-show="option.value === modelValue" class="app-icon parameter-picker-check" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
              <path d="M5 13L9 17L19 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </span>
          <span v-if="menuIcons !== false && (icon || $slots.icon)" class="parameter-picker-icon"><slot name="icon" :value="option.value"><AppIcon v-if="icon" :name="icon" /></slot></span>
          <span class="parameter-picker-text"><strong>{{ option.label }}</strong></span>
        </button>
      </div>
    </Teleport>
  </div>
</template>
