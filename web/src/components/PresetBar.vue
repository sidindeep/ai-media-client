<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { useStudioStore } from '../stores/studio';
import type { GenerationPreset } from '../types';

const studio = useStudioStore();
const root = ref<HTMLDetailsElement | null>(null);
const editorOpen = ref(false);
const name = ref('');
const input = ref<HTMLInputElement | null>(null);
const busy = ref(false);
const error = ref('');
const activePreset = computed(() => studio.presets.find(preset => studio.presetMatchesCurrent(preset)));
const activeId = computed(() => activePreset.value?.id || '');
const suggestedName = computed(() => studio.provider === 'media'
  ? (studio.currentMediaModel?.name.trim() || 'Мой пресет')
  : (studio.currentCodexModel?.name || 'Codex'));

function openEditor() {
  name.value = suggestedName.value;
  error.value = '';
  editorOpen.value = true;
  void nextTick(() => { input.value?.focus(); input.value?.select(); });
}

async function save() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await studio.saveCurrentPreset(name.value);
    editorOpen.value = false;
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Не удалось сохранить пресет'; }
  finally { busy.value = false; }
}

function apply(preset: GenerationPreset) {
  error.value = '';
  try {
    studio.applyPreset(preset);
    if (root.value) root.value.open = false;
  }
  catch (cause) { error.value = cause instanceof Error ? cause.message : 'Не удалось применить пресет'; }
}

async function remove(preset: GenerationPreset) {
  if (!confirm(`Удалить пресет «${preset.name}»?`)) return;
  error.value = '';
  try { await studio.removePreset(preset.id); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : 'Не удалось удалить пресет'; }
}
</script>

<template>
  <details ref="root" class="preset-bar">
    <summary class="preset-summary" title="Открыть пресеты">
      <span class="preset-summary-icon" aria-hidden="true">✦</span>
      <span class="preset-summary-copy"><small>Пресет</small><strong>{{ activePreset?.name || 'Без пресета' }}</strong></span>
      <span class="preset-summary-chevron" aria-hidden="true">⌄</span>
    </summary>
    <div class="preset-popover">
      <header class="preset-popover-header">
        <span>Пресеты</span>
        <button type="button" class="preset-add" aria-label="Сохранить текущие настройки как пресет" @click="openEditor">＋</button>
      </header>
      <div class="preset-list">
        <span v-for="preset in studio.presets" :key="preset.id" class="preset-chip" :class="{ active: preset.id === activeId }">
          <button type="button" class="preset-apply" :title="`Применить пресет «${preset.name}»`" @click="apply(preset)">{{ preset.name }}</button>
          <button type="button" class="preset-remove" :aria-label="`Удалить пресет ${preset.name}`" @click="remove(preset)">×</button>
        </span>
        <span v-if="!studio.presets.length" class="preset-empty">Сохранённых пресетов пока нет.</span>
      </div>
      <span v-if="error && !editorOpen" class="preset-error" role="alert">{{ error }}</span>
      <div v-if="editorOpen" class="preset-editor" @keydown.esc="editorOpen = false">
        <label for="presetName">Название пресета</label>
        <input id="presetName" ref="input" v-model="name" maxlength="80" @keydown.enter.prevent="save">
        <div class="preset-editor-actions">
          <button type="button" class="preset-cancel" :disabled="busy" @click="editorOpen = false">Отмена</button>
          <button type="button" class="preset-save" :disabled="busy || !name.trim()" @click="save">{{ busy ? 'Сохранение…' : 'Сохранить' }}</button>
        </div>
        <small>Сохранятся модель и параметры. Промпт и исходники не входят в пресет.</small>
        <span v-if="error" class="preset-error" role="alert">{{ error }}</span>
      </div>
    </div>
  </details>
</template>
