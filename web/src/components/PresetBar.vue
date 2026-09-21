<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { useStudioStore } from '../stores/studio';
import type { GenerationPreset } from '../types';

const studio = useStudioStore();
const editorOpen = ref(false);
const name = ref('');
const input = ref<HTMLInputElement | null>(null);
const busy = ref(false);
const error = ref('');
const activeId = computed(() => studio.presets.find(preset => studio.presetMatchesCurrent(preset))?.id || '');
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
  try { studio.applyPreset(preset); }
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
  <div class="preset-bar">
    <span class="preset-bar-label">ПРЕСЕТЫ</span>
    <div class="preset-list">
      <span v-for="preset in studio.presets" :key="preset.id" class="preset-chip" :class="{ active: preset.id === activeId }">
        <button type="button" class="preset-apply" :title="`Применить пресет «${preset.name}»`" @click="apply(preset)">{{ preset.name }}</button>
        <button type="button" class="preset-remove" :aria-label="`Удалить пресет ${preset.name}`" @click="remove(preset)">×</button>
      </span>
      <button type="button" class="preset-add" aria-label="Сохранить текущие настройки как пресет" @click="openEditor">＋</button>
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
</template>
