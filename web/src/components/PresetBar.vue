<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { useStudioStore } from '../stores/studio';
import { useI18n } from '../i18n';
import type { GenerationPreset } from '../types';

const studio = useStudioStore();
const { t } = useI18n();
const root = ref<HTMLDetailsElement | null>(null);
const editorOpen = ref(false);
const name = ref('');
const input = ref<HTMLInputElement | null>(null);
const busy = ref(false);
const error = ref('');
const activePreset = computed(() => studio.presets.find(preset => studio.presetMatchesCurrent(preset)));
const selectedPreset = computed(() => studio.presets.find(preset => preset.id === studio.selectedPresetId));
const displayedPreset = computed(() => selectedPreset.value || activePreset.value);
const hasSelectedChanges = computed(() => Boolean(selectedPreset.value && !studio.presetMatchesCurrent(selectedPreset.value)));
const activeId = computed(() => selectedPreset.value?.id || activePreset.value?.id || '');
const suggestedName = computed(() => studio.provider === 'media'
  ? (studio.currentMediaModel?.name.trim() || t('preset.defaultName'))
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
  } catch (cause) { error.value = cause instanceof Error ? cause.message : t('preset.saveError'); }
  finally { busy.value = false; }
}

async function updateSelected() {
  if (busy.value || !selectedPreset.value || !hasSelectedChanges.value) return;
  busy.value = true;
  error.value = '';
  try { await studio.saveCurrentPreset(selectedPreset.value.name, selectedPreset.value.id); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : t('preset.updateError'); }
  finally { busy.value = false; }
}

function apply(preset: GenerationPreset) {
  error.value = '';
  try {
    studio.applyPreset(preset);
    if (root.value) root.value.open = false;
  }
  catch (cause) { error.value = cause instanceof Error ? cause.message : t('preset.applyError'); }
}

async function remove(preset: GenerationPreset) {
  if (!confirm(t('preset.deleteConfirm', { name: preset.name }))) return;
  error.value = '';
  try { await studio.removePreset(preset.id); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : t('preset.deleteError'); }
}
</script>

<template>
  <details ref="root" class="preset-bar">
    <summary class="preset-summary" :title="t('preset.open')">
      <span class="preset-summary-icon" aria-hidden="true">✦</span>
      <span class="preset-summary-copy"><small>{{ hasSelectedChanges ? t('preset.changed') : t('preset.label') }}</small><strong>{{ displayedPreset?.name || t('preset.none') }}</strong></span>
      <span class="preset-summary-chevron" aria-hidden="true">⌄</span>
    </summary>
    <div class="preset-popover">
      <header class="preset-popover-header">
        <span>{{ t('preset.plural') }}</span>
        <span class="preset-header-actions">
          <button type="button" class="preset-update" :disabled="busy || editorOpen || !hasSelectedChanges" :title="selectedPreset ? t('preset.updateNamed', { name: selectedPreset.name }) : t('preset.applyFirst')" @click="updateSelected">{{ busy && !editorOpen ? t('common.saving') : t('common.save') }}</button>
          <button type="button" class="preset-add" :aria-label="t('preset.saveCurrent')" @click="openEditor">＋</button>
        </span>
      </header>
      <div class="preset-list">
        <span v-for="preset in studio.presets" :key="preset.id" class="preset-chip" :class="{ active: preset.id === activeId }">
          <button type="button" class="preset-apply" :title="t('preset.applyNamed', { name: preset.name })" @click="apply(preset)">{{ preset.name }}</button>
          <button type="button" class="preset-remove" :aria-label="t('preset.deleteNamed', { name: preset.name })" @click="remove(preset)">×</button>
        </span>
        <span v-if="!studio.presets.length" class="preset-empty">{{ t('preset.empty') }}</span>
      </div>
      <span v-if="error && !editorOpen" class="preset-error" role="alert">{{ error }}</span>
      <div v-if="editorOpen" class="preset-editor" @keydown.esc="editorOpen = false">
        <label for="presetName">{{ t('preset.name') }}</label>
        <input id="presetName" ref="input" v-model="name" maxlength="80" @keydown.enter.prevent="save">
        <div class="preset-editor-actions">
          <button type="button" class="preset-cancel" :disabled="busy" @click="editorOpen = false">{{ t('common.cancel') }}</button>
          <button type="button" class="preset-save" :disabled="busy || !name.trim()" @click="save">{{ busy ? t('common.saving') : t('common.save') }}</button>
        </div>
        <small>{{ t('preset.hint') }}</small>
        <span v-if="error" class="preset-error" role="alert">{{ error }}</span>
      </div>
    </div>
  </details>
</template>
