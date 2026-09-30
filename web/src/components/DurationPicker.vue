<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';

const props = defineProps<{ modelValue: string; options: Array<{ value: string; label: string }>; label: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const trigger = ref<HTMLButtonElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const list = ref<HTMLElement | null>(null);
const open = ref(false);
const active = ref(0);
const menuId = useId();
const position = ref({ left: 0, top: 0, width: 90, maxHeight: 320 });
const selected = computed(() => props.options.find(option => option.value === props.modelValue));
const needsScroll = ref(false);
const canScrollUp = ref(false);
const canScrollDown = ref(false);

function updateScroll() {
  if (!list.value) return;
  needsScroll.value = list.value.scrollHeight > position.value.maxHeight - 10 + 1;
  canScrollUp.value = list.value.scrollTop > 1;
  canScrollDown.value = list.value.scrollTop + list.value.clientHeight < list.value.scrollHeight - 1;
}
function place(event?: Event) {
  if (event && menu.value?.contains(event.target as Node)) return;
  if (!trigger.value) return;
  const rect = trigger.value.getBoundingClientRect();
  const width = Math.min(Math.max(90, rect.width), window.innerWidth - 20);
  const desired = Math.min(360, (list.value?.scrollHeight ?? props.options.length * 32) + 10);
  const aboveSpace = Math.max(0, rect.top - 18);
  const belowSpace = Math.max(0, window.innerHeight - rect.bottom - 18);
  const above = aboveSpace > belowSpace;
  const maxHeight = Math.max(48, Math.min(desired, above ? aboveSpace : belowSpace));
  position.value = { left: Math.max(10, Math.min(rect.left, window.innerWidth - width - 10)),
    top: above ? Math.max(10, rect.top - maxHeight - 8) : rect.bottom + 8, width, maxHeight };
  void nextTick(updateScroll);
}
function reveal() {
  list.value?.querySelector<HTMLElement>(`[data-index="${active.value}"]`)?.scrollIntoView({ block: 'nearest' });
  updateScroll();
}
async function show() {
  if (!props.options.length) return;
  active.value = Math.max(0, props.options.findIndex(option => option.value === props.modelValue));
  needsScroll.value = false;
  open.value = true;
  window.addEventListener('resize', place);
  window.addEventListener('scroll', place, true);
  document.addEventListener('pointerdown', outside);
  await nextTick();
  place();
  await nextTick();
  list.value?.focus();
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
    close();
    trigger.value?.focus();
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
  active.value = event.key === 'Home' ? 0 : event.key === 'End' ? props.options.length - 1
    : Math.max(0, Math.min(props.options.length - 1, active.value + (event.key === 'ArrowDown' ? 1 : -1)));
  void nextTick(reveal);
}
function scroll(direction: number) {
  list.value?.scrollBy({ top: direction * 96, behavior: 'smooth' });
}
watch(() => props.options, close);
onBeforeUnmount(close);
</script>

<template>
  <div class="duration-picker">
    <button ref="trigger" type="button" class="duration-picker-trigger" aria-haspopup="listbox" :aria-expanded="open" :aria-controls="menuId" :aria-label="`${label}: ${selected?.label || modelValue}`" @click="open ? close() : show()" @keydown.down.prevent="show" @keydown.up.prevent="show">
      <span>{{ selected?.label || modelValue }}</span><span aria-hidden="true">⌄</span>
    </button>
    <Teleport to="body">
      <div v-if="open" ref="menu" class="duration-picker-menu" :style="{ left: `${position.left}px`, top: `${position.top}px`, width: `${position.width}px`, maxHeight: `${position.maxHeight}px` }" @keydown="keydown">
        <button v-if="needsScroll" type="button" class="duration-scroll-arrow" tabindex="-1" :disabled="!canScrollUp" :aria-label="label" @click="scroll(-1)">⌃</button>
        <div :id="menuId" ref="list" class="duration-picker-list" role="listbox" tabindex="0" :aria-label="label" :aria-activedescendant="`${menuId}-${active}`" @scroll="updateScroll">
          <button v-for="(option, index) in options" :id="`${menuId}-${index}`" :key="option.value" type="button" role="option" tabindex="-1" :data-index="index" :aria-selected="option.value === modelValue" :class="{ 'is-active': index === active }" @click="choose(option.value)">
            <span>{{ option.label }}</span><span v-if="option.value === modelValue" aria-hidden="true">✓</span>
          </button>
        </div>
        <button v-if="needsScroll" type="button" class="duration-scroll-arrow" tabindex="-1" :disabled="!canScrollDown" :aria-label="label" @click="scroll(1)">⌄</button>
      </div>
    </Teleport>
  </div>
</template>
