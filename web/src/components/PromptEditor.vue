<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, useId } from 'vue';
import AppIcon from './AppIcon.vue';
import { useI18n } from '../i18n';
import { createPromptLineScroll } from '../domain/prompt-scroll';

defineProps<{ modelValue: string; placeholder: string }>();
const emit = defineEmits<{
  'update:modelValue': [value: string];
  submit: [event: KeyboardEvent];
}>();
const { t } = useI18n();
const titleId = useId();
const compact = ref<HTMLTextAreaElement | null>(null);
const expanded = ref<HTMLTextAreaElement | null>(null);
const dialog = ref<HTMLDialogElement | null>(null);
let previousOverflow: string | null = null;
let backdropPressed = false;
const lineScroll = createPromptLineScroll(() => compact.value
  ? Number.parseFloat(getComputedStyle(compact.value).lineHeight) : 0);

function update(event: Event) {
  lineScroll.cancel();
  emit('update:modelValue', (event.target as HTMLTextAreaElement).value);
}
async function openEditor() {
  if (!dialog.value || dialog.value.open || !compact.value) return;
  lineScroll.cancel();
  const { selectionStart, selectionEnd, selectionDirection } = compact.value;
  previousOverflow = document.documentElement.style.overflow;
  document.documentElement.style.overflow = 'hidden';
  dialog.value.showModal();
  await nextTick();
  if (!dialog.value?.open || !expanded.value) return;
  expanded.value.focus({ preventScroll: true });
  expanded.value.setSelectionRange(selectionStart, selectionEnd, selectionDirection);
}
function closeEditor() {
  if (!dialog.value?.open) return;
  const source = expanded.value;
  dialog.value.close();
  releasePage();
  if (source && compact.value) {
    compact.value.focus({ preventScroll: true });
    compact.value.setSelectionRange(source.selectionStart, source.selectionEnd, source.selectionDirection);
  }
}
function releasePage() {
  if (previousOverflow !== null) document.documentElement.style.overflow = previousOverflow;
  previousOverflow = null;
}
function outside(event: PointerEvent) {
  if (event.target !== dialog.value || !dialog.value) return false;
  const rect = dialog.value.getBoundingClientRect();
  return event.clientX < rect.left || event.clientX > rect.right
    || event.clientY < rect.top || event.clientY > rect.bottom;
}
function backdropRelease(event: PointerEvent) {
  if (backdropPressed && outside(event)) closeEditor();
  backdropPressed = false;
}
function backdropPress(event: PointerEvent) {
  backdropPressed = outside(event);
}
function wheel(event: WheelEvent) {
  if (compact.value) lineScroll.wheel(compact.value, event);
}
onMounted(() => {
  window.addEventListener('pointerup', lineScroll.pointerEnd);
  window.addEventListener('pointercancel', lineScroll.pointerEnd);
});
onBeforeUnmount(() => {
  lineScroll.cancel();
  window.removeEventListener('pointerup', lineScroll.pointerEnd);
  window.removeEventListener('pointercancel', lineScroll.pointerEnd);
  dialog.value?.close();
  releasePage();
});
</script>

<template>
  <div class="prompt-input">
    <textarea ref="compact" :value="modelValue" rows="5" maxlength="20000" :placeholder="placeholder"
      :aria-label="t('composer.promptAria')" @input="update" @keydown="lineScroll.cancel"
      @keydown.ctrl.enter="emit('submit', $event)" @wheel="wheel"
      @touchstart.passive="lineScroll.cancel" @pointerdown="lineScroll.pointerStart"
      @blur="lineScroll.cancel"></textarea>
    <div class="prompt-input-actions">
      <button type="button" class="prompt-expand" aria-haspopup="dialog" @click="openEditor">
        <AppIcon name="fullscreen" /> {{ t('composer.expandPrompt') }}
      </button>
    </div>
  </div>
  <Teleport to="body">
    <dialog ref="dialog" class="popup-dialog prompt-editor-dialog" :aria-labelledby="titleId"
      aria-modal="true" @cancel.prevent="closeEditor" @close="releasePage"
      @pointerdown="backdropPress" @pointerup="backdropRelease">
      <header class="popup-header">
        <h2 :id="titleId">{{ t('composer.promptAria') }}</h2>
        <button type="button" class="popup-close" :aria-label="t('common.close')" @click="closeEditor"><AppIcon name="close" /></button>
      </header>
      <textarea ref="expanded" class="prompt-editor-textarea" :value="modelValue" maxlength="20000"
        :placeholder="placeholder" :aria-label="t('composer.promptAria')" @input="update"></textarea>
      <footer class="prompt-editor-footer">
        <p>{{ t('composer.expandedPromptHint') }}</p>
        <button type="button" class="primary-button" @click="closeEditor">{{ t('common.close') }}</button>
      </footer>
    </dialog>
  </Teleport>
</template>

<style scoped>
.prompt-input-actions { display: flex; justify-content: flex-end; margin: 3px 0 6px; }
.prompt-expand { display: inline-flex; align-items: center; gap: 5px; border: 0; border-radius: 6px; padding: 4px 6px; color: #aaa2bf; background: transparent; font-size: 11px; cursor: pointer; }
.prompt-expand:hover { color: #ded5f7; background: #8f75ff18; }
.prompt-expand:focus-visible { outline: 2px solid #9d83f5; outline-offset: 2px; }
.prompt-editor-dialog { width: min(960px, calc(100vw - 32px)); }
.prompt-editor-dialog .popup-header { margin-bottom: 18px; }
.prompt-editor-textarea { display: block; width: 100%; height: min(60dvh, 560px); min-height: 7.5em; resize: none; border: 1px solid #514663; border-radius: 12px; padding: 14px; outline: none; color: #f3effb; background: #11121b; color-scheme: dark; font-size: 16px; line-height: 1.5; }
.prompt-editor-textarea:focus { border-color: #a289f0; box-shadow: 0 0 0 2px #a289f025; }
.prompt-editor-footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 16px; }
.prompt-editor-footer p { margin: 0; color: #aaa2bf; font-size: 12px; line-height: 1.5; }
.prompt-editor-footer button { flex: none; cursor: pointer; }
:root[data-theme='light'] .prompt-expand, :root[data-theme='light'] .prompt-editor-footer p { color: #675b79; }
:root[data-theme='light'] .prompt-editor-textarea { border-color: #c7bdd7; color: #30283d; background: #fff; color-scheme: light; }
@media (max-width: 480px) {
  .prompt-editor-dialog { padding: 16px; }
  .prompt-editor-textarea { height: 55dvh; }
}
</style>
