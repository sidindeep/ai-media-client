<script setup lang="ts">
import AppIcon from "../components/AppIcon.vue";
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from '../i18n';
import { popups } from './service';

const { t } = useI18n();
const { active, busy, error } = popups;
const dialog = ref<HTMLDialogElement | null>(null);
const field = ref<HTMLInputElement | HTMLSelectElement | null>(null);
const cancelButton = ref<HTMLButtonElement | null>(null);
const submitButton = ref<HTMLButtonElement | null>(null);
const value = ref('');
let previousFocus: HTMLElement | null = null;
let previousOverflow: string | null = null;
let backdropPressed = false;
const valid = computed(() => active.value?.kind === 'prompt'
  ? Boolean(value.value.trim()) && (active.value.maxLength === undefined || value.value.trim().length <= active.value.maxLength)
  : active.value?.kind !== 'select' || Boolean(active.value.options?.some(option => option.value === value.value)));

function releasePage() {
  if (previousOverflow !== null) document.documentElement.style.overflow = previousOverflow;
  previousOverflow = null;
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  previousFocus = null;
}
watch(() => active.value?.id, async () => {
  const request = active.value;
  if (!request) {
    dialog.value?.close();
    releasePage();
    return;
  }
  if (previousOverflow === null) {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
  }
  value.value = request.initialValue ?? request.options?.[0]?.value ?? '';
  backdropPressed = false;
  await nextTick();
  if (active.value?.id !== request.id || !dialog.value) return;
  if (!dialog.value.open) dialog.value.showModal();
  const target = field.value || (request.kind === 'confirm' ? cancelButton.value : submitButton.value);
  target?.focus();
  if (field.value instanceof HTMLInputElement) field.value.select();
});
function outside(event: PointerEvent) {
  if (event.target !== dialog.value || !dialog.value) return false;
  const rect = dialog.value.getBoundingClientRect();
  return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
}
function backdropRelease(event: PointerEvent) {
  if (backdropPressed && outside(event)) popups.cancel();
  backdropPressed = false;
}
function backdropPress(event: PointerEvent) {
  backdropPressed = outside(event);
}
onBeforeUnmount(() => {
  dialog.value?.close();
  popups.dismissAll();
  releasePage();
});
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="popup-dialog" :class="{ 'popup-danger': active?.danger }"
      :role="active?.kind === 'confirm' || active?.kind === 'alert' ? 'alertdialog' : 'dialog'"
      aria-modal="true" aria-labelledby="popup-title" :aria-describedby="active?.message ? 'popup-message' : undefined"
      :aria-busy="busy" @cancel.prevent="popups.cancel()"
      @keydown.esc.stop.prevent="popups.cancel()"
      @pointerdown="backdropPress" @pointerup="backdropRelease">
      <form v-if="active" @submit.prevent="popups.submit(value)">
        <header class="popup-header">
          <span class="popup-icon" aria-hidden="true"><AppIcon :name="active.danger ? 'error' : active.kind === 'confirm' ? 'question' : 'rename'" /></span>
          <h2 id="popup-title">{{ active.title }}</h2>
          <button class="popup-close" type="button" :disabled="busy" :aria-label="t('common.close')" @click="popups.cancel()"><AppIcon name="close" /></button>
        </header>
        <p v-if="active.message" id="popup-message" class="popup-message">{{ active.message }}</p>
        <label v-if="active.kind === 'prompt' || active.kind === 'select'" class="popup-field">
          <span>{{ active.label }}</span>
          <input v-if="active.kind === 'prompt'" ref="field" v-model="value" type="text" :maxlength="active.maxLength" :disabled="busy" required autocomplete="off" :aria-invalid="error !== null" :aria-describedby="error !== null ? 'popup-error' : undefined">
          <select v-else ref="field" v-model="value" :disabled="busy" :aria-describedby="error !== null ? 'popup-error' : undefined">
            <option v-for="option in active.options" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
        </label>
        <p v-if="error !== null" id="popup-error" class="popup-error" role="alert">{{ error || t('popup.failed') }}</p>
        <footer class="popup-actions">
          <button v-if="active.kind !== 'alert'" ref="cancelButton" type="button" class="popup-cancel" :disabled="busy" @click="popups.cancel()">{{ active.cancelLabel || t('common.cancel') }}</button>
          <button ref="submitButton" type="submit" class="popup-submit" :disabled="busy || !valid">{{ busy ? t('popup.working') : active.confirmLabel || t('popup.confirm') }}</button>
        </footer>
      </form>
    </dialog>
  </Teleport>
</template>
