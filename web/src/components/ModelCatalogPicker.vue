<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { MODEL_BRANDS, modelBrand, modelSummary, type ModelPickerOption } from '../domain/model-catalog';

const props = defineProps<{
  modelValue: string;
  models: ModelPickerOption[];
  price?: string;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const root = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const searchInput = ref<HTMLInputElement | null>(null);
const open = ref(false);
const search = ref('');
const activeGroup = ref('');
const panelStyle = ref<Record<string, string>>({});

const selected = computed(() => props.models.find(model => model.value === props.modelValue) || props.models[0]);
const selectedBrand = computed(() => modelBrand(selected.value?.groupId || 'other'));
const normalizedSearch = computed(() => search.value.trim().toLocaleLowerCase('ru-RU'));
const matchingModels = computed(() => {
  if (!normalizedSearch.value) return props.models;
  return props.models.filter(model => `${model.label} ${model.description || ''} ${modelBrand(model.groupId).label}`.toLocaleLowerCase('ru-RU').includes(normalizedSearch.value));
});
const groups = computed(() => MODEL_BRANDS.map(brand => ({
  ...brand,
  count: props.models.filter(model => model.groupId === brand.id).length,
  matchCount: matchingModels.value.filter(model => model.groupId === brand.id).length,
})).filter(group => group.count > 0));
const shownModels = computed(() => normalizedSearch.value
  ? matchingModels.value
  : props.models.filter(model => model.groupId === activeGroup.value));

function setInitialGroup() {
  const selectedGroup = selected.value?.groupId;
  activeGroup.value = groups.value.some(group => group.id === selectedGroup) ? selectedGroup! : (groups.value[0]?.id || '');
}

function updatePosition() {
  const element = trigger.value;
  if (!element) return;
  const rect = element.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.min(720, viewportWidth - 24);
  const left = Math.max(12, Math.min(rect.left, viewportWidth - width - 12));
  const above = rect.top - 20;
  const below = viewportHeight - rect.bottom - 20;
  const useAbove = above > below && above >= 280;
  const height = Math.max(240, Math.min(500, useAbove ? above : below));
  const top = useAbove ? Math.max(12, rect.top - height - 8) : rect.bottom + 8;
  panelStyle.value = { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` };
}

async function show() {
  if (!props.models.length) return;
  setInitialGroup();
  search.value = '';
  open.value = true;
  await nextTick();
  updatePosition();
  searchInput.value?.focus();
}

function close() {
  if (!open.value) return;
  open.value = false;
  search.value = '';
  nextTick(() => trigger.value?.focus());
}

function choose(value: string) {
  if (value !== props.modelValue) emit('update:modelValue', value);
  close();
}

function chooseGroup(id: string) {
  activeGroup.value = id;
  if (normalizedSearch.value) search.value = '';
  nextTick(() => panel.value?.querySelector<HTMLButtonElement>('.model-catalog-item')?.focus());
}

function nativeChange(event: Event) {
  emit('update:modelValue', (event.target as HTMLSelectElement).value);
}

function onPointerDown(event: PointerEvent) {
  const target = event.target as Node;
  if (!root.value?.contains(target) && !panel.value?.contains(target)) close();
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') close();
}

watch(() => props.models, () => {
  if (!groups.value.some(group => group.id === activeGroup.value)) setInitialGroup();
}, { deep: true });
watch(open, value => {
  if (value) {
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeydown);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
  } else {
    document.removeEventListener('pointerdown', onPointerDown);
    document.removeEventListener('keydown', onKeydown);
    window.removeEventListener('resize', updatePosition);
    window.removeEventListener('scroll', updatePosition, true);
  }
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onPointerDown);
  document.removeEventListener('keydown', onKeydown);
  window.removeEventListener('resize', updatePosition);
  window.removeEventListener('scroll', updatePosition, true);
});
</script>

<template>
  <div ref="root" class="model-picker model-pill">
    <button ref="trigger" type="button" class="model-picker-trigger select-pill" aria-haspopup="listbox" :aria-expanded="open" :disabled="!models.length" @click="open ? close() : show()">
      <span class="model-picker-label">Модель</span>
      <span class="model-brand-icon compact" :style="{ '--brand-accent': selectedBrand.accent }">
        <img v-if="selectedBrand.icon" :src="selectedBrand.icon" alt="" :class="{ monochrome: selectedBrand.monochrome }">
        <span v-else>{{ selectedBrand.label.slice(0, 1) }}</span>
      </span>
      <strong>{{ selected?.label || 'Нет моделей' }}</strong>
      <span class="model-picker-chevron" aria-hidden="true">⌄</span>
    </button>
    <select class="model-native-select" :value="modelValue" tabindex="-1" aria-hidden="true" @change="nativeChange">
      <option v-for="model in models" :key="model.value" :value="model.value">{{ model.label }}</option>
    </select>
    <Teleport to="body">
      <section v-if="open" ref="panel" class="model-catalog-popover" :style="panelStyle" aria-label="Выбор модели">
        <label class="model-catalog-search">
          <span aria-hidden="true">⌕</span>
          <input ref="searchInput" v-model="search" type="search" placeholder="Поиск моделей..." autocomplete="off">
          <button v-if="search" type="button" aria-label="Очистить поиск" @click="search = ''">×</button>
        </label>
        <div class="model-catalog-body">
          <nav class="model-brand-list" aria-label="Разработчики моделей">
            <button v-for="group in groups" :key="group.id" type="button" :class="{ active: !normalizedSearch && activeGroup === group.id, muted: normalizedSearch && !group.matchCount }" @click="chooseGroup(group.id)">
              <span class="model-brand-icon" :style="{ '--brand-accent': group.accent }">
                <img v-if="group.icon" :src="group.icon" alt="" :class="{ monochrome: group.monochrome }">
                <span v-else>{{ group.label.slice(0, 1) }}</span>
              </span>
              <strong>{{ group.label }}</strong>
              <small>{{ normalizedSearch ? group.matchCount : group.count }}</small>
            </button>
          </nav>
          <div class="model-catalog-list" role="listbox" :aria-label="normalizedSearch ? 'Результаты поиска' : modelBrand(activeGroup).label">
            <button v-for="model in shownModels" :key="model.value" type="button" class="model-catalog-item" role="option" :aria-selected="model.value === modelValue" :class="{ selected: model.value === modelValue }" @click="choose(model.value)">
              <span class="model-brand-icon row-icon" :style="{ '--brand-accent': modelBrand(model.groupId).accent }">
                <img v-if="modelBrand(model.groupId).icon" :src="modelBrand(model.groupId).icon" alt="" :class="{ monochrome: modelBrand(model.groupId).monochrome }">
                <span v-else>{{ modelBrand(model.groupId).label.slice(0, 1) }}</span>
              </span>
              <span class="model-catalog-copy">
                <strong>{{ model.label }}</strong>
                <small>{{ modelSummary(model.label, model.description) }}</small>
                <span v-if="model.value === modelValue && price" class="model-catalog-price">↯ {{ price }}</span>
                <span v-else class="model-catalog-provider">{{ modelBrand(model.groupId).label }}</span>
              </span>
              <span v-if="model.value === modelValue" class="model-selected-check" aria-hidden="true">✓</span>
            </button>
            <p v-if="!shownModels.length" class="model-catalog-empty">По вашему запросу модели не найдены.</p>
          </div>
        </div>
      </section>
    </Teleport>
  </div>
</template>
