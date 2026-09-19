<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useStudioStore } from '../stores/studio';
import { getCodexQuote, getMediaQuote, uploadSource } from '../api/client';
import type { MediaField } from '../types';

const studio = useStudioStore();
const sending = ref(false);
const uploading = ref(false);
const submitError = ref('');
const quote = ref<{ credits: number } | null>(null);
const quoteError = ref('');
const effortOptions = computed(() => studio.currentCodexModel?.efforts || ['low', 'medium', 'high']);
const currentFields = computed(() => studio.currentMediaModel?.fields || []);
const fileFields = computed(() => currentFields.value.filter(field => field.type === 'files'));
const primaryFields = computed(() => currentFields.value.filter(field => /aspect|ratio|format|resolution|quality/i.test(field.key) && (field.options?.length || field.schema?.enum?.length)).slice(0, 2));
const extraFields = computed(() => currentFields.value.filter(field => !/prompt/i.test(field.key) && field.type !== 'files' && !primaryFields.value.includes(field)));
const total = computed(() => quote.value ? quote.value.credits * studio.quantity : null);
const modelChoice = computed({
  get: () => studio.provider === 'codex' ? 'codex:' + studio.codexModel : 'media:' + studio.mediaModelId,
  set: value => {
    if (value.startsWith('codex:')) { studio.provider = 'codex'; studio.codexModel = value.slice(6); }
    else { studio.provider = 'media'; studio.mediaModelId = value.slice(6); }
  },
});
const modelOptions = computed(() => [
  ...(['text', 'image'].includes(studio.mode) ? (studio.codexCatalog?.models || []).map(model => ({ value: 'codex:' + model.id, label: model.name + ' · Codex' })) : []),
  ...studio.mediaModels.map(model => ({ value: 'media:' + model.id, label: model.name })),
]);

function fieldOptions(field: MediaField) { return field.options || field.schema?.enum || []; }
function updateField(key: string, value: unknown) { studio.mediaInput = { ...studio.mediaInput, [key]: value }; }
function fieldValue(field: MediaField) { return studio.mediaInput[field.key] ?? field.default ?? ''; }
function updateSelect(field: MediaField, event: Event) {
  const raw = (event.target as HTMLSelectElement).value;
  const typed = fieldOptions(field).find(option => String(option) === raw);
  updateField(field.key, typed === undefined ? raw : typed);
}

watch(() => studio.currentMediaModel?.id, () => {
  const defaults = Object.fromEntries(currentFields.value.filter(field => field.default !== undefined).map(field => [field.key, field.default]));
  studio.mediaInput = { ...defaults, ...studio.mediaInput };
}, { immediate: true });

async function refreshQuote() {
  quoteError.value = '';
  try {
    if (studio.provider === 'codex') {
      if (!studio.codexModel || !studio.codexEffort) return;
      const result = await getCodexQuote(studio.codexModel, studio.codexEffort, studio.codexSpeed);
      quote.value = result.quote; quoteError.value = result.error || '';
    } else if (studio.mediaModelId) {
      quote.value = await getMediaQuote(studio.mediaModelId, { ...studio.mediaInput, prompt: studio.prompt });
    }
  } catch (error) {
    quote.value = null; quoteError.value = error instanceof Error ? error.message : 'Цена недоступна';
  }
}
watch(() => [studio.provider, studio.codexModel, studio.codexEffort, studio.codexSpeed, studio.mediaModelId, studio.mediaInput, studio.prompt, studio.quantity], refreshQuote, { immediate: true, deep: true });

async function addFiles(event: Event, field?: MediaField) {
  const input = event.target as HTMLInputElement;
  const files = [...(input.files || [])];
  if (!files.length) return;
  uploading.value = true; submitError.value = '';
  try {
    const added = [];
    for (const file of files) {
      if (field?.maxSizeMb && file.size > field.maxSizeMb * 1024 * 1024) throw new Error(file.name + ': превышен лимит ' + field.maxSizeMb + ' МБ');
      const saved = await uploadSource(file, { projectId: studio.activeProjectId, chatId: studio.activeChatId === 'system:recent' ? null : studio.activeChatId });
      const item = { ...saved, ref: saved.ref, name: file.name, type: file.type, fieldKey: field?.key };
      studio.sourceFiles.push(item); added.push(item.ref);
    }
    if (field) updateField(field.key, field.scalar || field.maxFiles === 1 ? added.at(-1) : [...(Array.isArray(studio.mediaInput[field.key]) ? studio.mediaInput[field.key] as string[] : []), ...added]);
  } catch (error) { submitError.value = error instanceof Error ? error.message : 'Не удалось загрузить исходник'; }
  finally { uploading.value = false; input.value = ''; }
}
function removeFile(index: number) {
  const item = studio.sourceFiles[index]; studio.sourceFiles.splice(index, 1);
  if (item.fieldKey) {
    const remaining = studio.sourceFiles.filter(file => file.fieldKey === item.fieldKey).map(file => file.ref);
    updateField(item.fieldKey, remaining.length > 1 ? remaining : remaining[0] || undefined);
  }
}
async function submit() {
  sending.value = true; submitError.value = '';
  try { await studio.submit(); } catch (error) { submitError.value = error instanceof Error ? error.message : 'Не удалось запустить генерацию'; } finally { sending.value = false; }
}
</script>

<template>
  <section class="composer-card">
    <div class="composer-tabs">
      <button v-for="item in [{ id: 'text', label: 'Текст', icon: '▢' }, { id: 'image', label: 'Изображение', icon: '▧' }, { id: 'video', label: 'Видео', icon: '▹' }, { id: 'audio', label: 'Аудио', icon: '⌁' }]" :key="item.id" type="button" :class="{ active: studio.mode === item.id }" @click="studio.setMode(item.id as 'text' | 'image' | 'video' | 'audio')">{{ item.icon }} {{ item.label }}</button>
    </div>
    <div class="composer-body">
      <textarea v-model="studio.prompt" maxlength="20000" placeholder="Введите идею для генерации" aria-label="Промпт генерации" @keydown.ctrl.enter="submit"></textarea>
      <div class="source-strip">
        <label v-if="studio.provider === 'codex'" class="attach-button">＋ Исходники<input type="file" accept="image/png,image/jpeg,image/webp" multiple @change="addFiles($event)" /></label>
        <label v-for="field in fileFields" v-else :key="field.key" class="attach-button">＋ {{ field.label || 'Исходники' }}<input type="file" :accept="field.accept" :multiple="!field.scalar && field.maxFiles !== 1" @change="addFiles($event, field)" /></label>
        <span v-if="uploading" class="uploading">Загрузка…</span>
        <button v-for="(file, index) in studio.sourceFiles" :key="file.ref + index" type="button" class="source-chip" @click="removeFile(index)">{{ file.name }} ×</button>
      </div>
      <div class="composer-controls">
        <label class="select-pill model-pill"><span>Модель</span><select v-model="modelChoice"><option v-for="model in modelOptions" :key="model.value" :value="model.value">{{ model.label }}</option></select></label>
        <template v-if="studio.provider === 'codex'">
          <label class="select-pill"><span>Рассуждение</span><select v-model="studio.codexEffort"><option v-for="effort in effortOptions" :key="effort" :value="effort">{{ effort }}</option></select></label>
          <label v-if="studio.mode === 'image'" class="select-pill"><span>Формат</span><select v-model="studio.codexAspectRatio"><option value="auto">Авто</option><option value="1:1">1:1</option><option value="16:9">16:9</option><option value="9:16">9:16</option><option value="3:2">3:2</option><option value="2:3">2:3</option></select></label>
          <label class="select-pill"><span>Скорость</span><select v-model="studio.codexSpeed"><option value="standard">Обычная</option><option value="fast">⚡ Fast</option></select></label>
        </template>
        <label v-for="field in primaryFields" v-else :key="field.key" class="select-pill"><span>{{ field.label || field.key }}</span><select :value="fieldValue(field)" @change="updateSelect(field, $event)"><option v-for="option in fieldOptions(field)" :key="String(option)" :value="String(option)">{{ option }}</option></select></label>
        <label class="select-pill"><span>Количество</span><select v-model.number="studio.quantity"><option v-for="count in 4" :key="count" :value="count">{{ count }} шт.</option></select></label>
        <span v-if="total !== null" class="quote">Итого: {{ total.toLocaleString('ru-RU') }} кредитов</span>
        <span v-else-if="quoteError" class="quote error">{{ quoteError }}</span>
        <button class="generate-button" type="button" :disabled="sending || uploading || !studio.prompt.trim() || !modelOptions.length" @click="submit">{{ sending ? 'Запуск…' : 'Генерировать' }}<span v-if="total !== null"> · {{ total.toLocaleString('ru-RU') }}</span> <span aria-hidden="true">↗</span></button>
      </div>
      <details v-if="studio.provider === 'media' && extraFields.length" class="advanced-settings"><summary>Дополнительные параметры</summary><div class="advanced-grid"><label v-for="field in extraFields" :key="field.key"><span>{{ field.label || field.key }}</span><select v-if="fieldOptions(field).length" :value="fieldValue(field)" @change="updateSelect(field, $event)"><option v-for="option in fieldOptions(field)" :key="String(option)" :value="String(option)">{{ option }}</option></select><input v-else-if="field.type === 'number'" type="number" :min="field.min" :max="field.max" :step="field.step" :value="fieldValue(field)" @input="updateField(field.key, Number(($event.target as HTMLInputElement).value))" /><input v-else-if="field.type === 'boolean'" type="checkbox" :checked="Boolean(fieldValue(field))" @change="updateField(field.key, ($event.target as HTMLInputElement).checked)" /><textarea v-else-if="field.type === 'textarea' || field.type === 'json'" :value="String(fieldValue(field))" @input="updateField(field.key, ($event.target as HTMLTextAreaElement).value)"></textarea><input v-else type="text" :value="String(fieldValue(field))" @input="updateField(field.key, ($event.target as HTMLInputElement).value)" /></label></div></details>
      <p v-if="submitError" class="form-error" role="alert">{{ submitError }}</p>
      <p class="composer-hint">Ctrl + Enter — запустить · черновик сохраняется в текущем чате</p>
    </div>
  </section>
</template>
