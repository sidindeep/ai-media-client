<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useStudioStore } from '../stores/studio';
import { diagnoseProvider, getCodexQuote, getMediaQuote, uploadSource } from '../api/client';
import type { ProviderDiagnostics } from '../api/client';
import type { MediaField } from '../types';
import ModelCatalogPicker from './ModelCatalogPicker.vue';
import AspectRatioPicker from './AspectRatioPicker.vue';
import PresetBar from './PresetBar.vue';
import { formatMediaFieldValue, mediaFieldOptions, parseMediaFieldValue } from '../domain/media-fields';
import { mediaModelBrandId } from '../domain/model-catalog';
import { aspectRatioName, isAspectRatioField } from '../domain/aspect-ratios';

const studio = useStudioStore();
const uploading = ref(false);
const submitError = ref('');
const quote = ref<{ credits: number } | null>(null);
const quoteError = ref('');
const quoteLoading = ref(false);
const diagnosticOpen = ref(false);
const diagnosticLoading = ref(false);
const diagnosticError = ref('');
const diagnostics = ref<ProviderDiagnostics | null>(null);
const fieldErrors = ref<Record<string, string>>({});
const draggingFiles = ref(false);
const activeDropFieldKey = ref('');
let quoteRevision = 0;
let quoteTimer: ReturnType<typeof setTimeout> | null = null;
const QUOTE_DEBOUNCE_MS = 1500;
const effortOptions = computed(() => studio.currentCodexModel?.efforts || ['low', 'medium', 'high']);
const currentFields = computed(() => studio.currentMediaModel?.fields || []);
const fileFields = computed(() => currentFields.value.filter(field => field.type === 'files'));
const codexAcceptsImages = computed(() => studio.currentCodexModel?.inputModalities?.includes('image') === true);
const hasSourcePicker = computed(() => studio.provider === 'codex' ? codexAcceptsImages.value : fileFields.value.length > 0);
const dropFields = computed(() => studio.provider === 'media' ? fileFields.value : []);
const dropReady = computed(() => studio.accountReady && !uploading.value && hasSourcePicker.value);
const dropTitle = computed(() => {
  if (!studio.accountReady) return 'Чат ещё загружается';
  if (uploading.value) return 'Дождитесь загрузки текущего файла';
  if (!hasSourcePicker.value) return 'Текущая модель не принимает файлы';
  return dropFields.value.length > 1 ? 'Выберите назначение файла' : 'Готов принять файл';
});
const dropDescription = computed(() => {
  if (!studio.accountReady) return 'Файл можно будет добавить сразу после восстановления чата.';
  if (uploading.value) return 'Следующий файл можно добавить после завершения текущей загрузки.';
  if (!hasSourcePicker.value) return 'Выберите модель с поддержкой исходников — сам файл не будет потерян или открыт браузером.';
  if (dropFields.value.length > 1) return 'У модели несколько файловых полей. Перетащите файл в нужную область ниже.';
  const field = dropFields.value[0];
  return field?.label ? `Отпустите файл, чтобы добавить его в «${field.label}».` : 'Отпустите файл — он прикрепится к текущему чату.';
});
const primaryFields = computed(() => currentFields.value.filter(field => /aspect|ratio|format|resolution|quality/i.test(field.key) && (field.options?.length || field.schema?.enum?.length)).slice(0, 2));
const extraFields = computed(() => currentFields.value.filter(field => !/prompt/i.test(field.key) && field.type !== 'files' && !primaryFields.value.includes(field)));
const total = computed(() => quote.value?.credits ?? null);
const modelChoice = computed({
  get: () => studio.provider === 'codex' ? studio.codexModel : studio.mediaModelId,
  set: value => {
    if (studio.provider === 'codex') studio.codexModel = value;
    else {
      studio.mediaInput = {};
      studio.sourceFiles = [];
      fieldErrors.value = {};
      studio.mediaModelId = value;
    }
  },
});
const modelOptions = computed(() => studio.provider === 'codex'
  ? (studio.codexCatalog?.models || []).map(model => ({ value: model.id, label: model.name, description: 'Текст и изображения через Codex CLI.', groupId: 'codex' }))
  : studio.mediaModels.map(model => ({ value: model.id, label: model.name.trim(), description: model.description, groupId: mediaModelBrandId(model.id, model.name) })));
const promptField = computed(() => studio.provider === 'media' ? currentFields.value.find(field => field.key === 'prompt' || field.key === 'text') : undefined);
const showsPrompt = computed(() => studio.provider === 'codex' || Boolean(promptField.value));
const promptValue = computed({
  get: () => promptField.value?.key === 'text' ? String(studio.mediaInput.text || '') : studio.prompt,
  set: value => { if (promptField.value?.key === 'text') updateField('text', value); else studio.prompt = value; },
});
const promptPlaceholder = computed(() => studio.mode === 'audio'
  ? promptField.value?.key === 'text' ? 'Введите текст для озвучивания' : 'Опишите музыку или звук'
  : 'Введите идею для генерации');
const selectedModelPrice = computed(() => quote.value ? `${quote.value.credits.toLocaleString('ru-RU')} кр.` : undefined);
const hasFieldErrors = computed(() => Object.keys(fieldErrors.value).length > 0);
const missingRequiredFields = computed(() => studio.provider === 'media' ? currentFields.value.filter(field => {
  if (!field.required) return false;
  if (field.key === 'prompt') return !studio.prompt.trim();
  const value = studio.mediaInput[field.key];
  return value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length);
}) : []);
const mediaRequestInput = () => ({ ...studio.mediaInput, ...(promptField.value?.key === 'prompt' ? { prompt: studio.prompt } : {}) });
const retryableQuoteError = (error: unknown) => error instanceof Error
  && /^(?:Не удалось выполнить запрос|Некорректный ответ сервиса|Связь с базой данных временно недоступна)/i.test(error.message);

function fieldOptions(field: MediaField) { return mediaFieldOptions(field); }
function fieldOptionLabel(field: MediaField, option: unknown) {
  const name = isAspectRatioField(field.key) ? aspectRatioName(option) : '';
  return name ? `${option} — ${name}` : String(option);
}
function sourceButtonLabel(field: MediaField) { return fileFields.value.length === 1 ? 'Исходники' : (field.label || 'Исходники'); }
function sourceFieldLabel(fieldKey?: string) { return fileFields.value.find(field => field.key === fieldKey)?.label || ''; }
function sourcePreviewUrl(ref: string) {
  const id = /^https:\/\/local-assets\.invalid\/([a-f0-9]{64})$/.exec(ref)?.[1];
  return id ? `/api/sources/${id}` : '';
}
function isImageSource(type: string) { return type.startsWith('image/'); }
function updateField(key: string, value: unknown) {
  const input = { ...studio.mediaInput };
  if (value === undefined) delete input[key]; else input[key] = value;
  studio.mediaInput = input;
}
function fieldValue(field: MediaField) { return formatMediaFieldValue(field, studio.mediaInput[field.key] ?? field.default); }
function updateTypedField(field: MediaField, raw: unknown) {
  try {
    updateField(field.key, parseMediaFieldValue(field, raw));
    const errors = { ...fieldErrors.value }; delete errors[field.key]; fieldErrors.value = errors;
  } catch (error) {
    fieldErrors.value = { ...fieldErrors.value, [field.key]: error instanceof Error ? error.message : 'Некорректное значение' };
  }
}
function updateSelect(field: MediaField, event: Event) {
  updateSelectValue(field, (event.target as HTMLSelectElement).value);
}
function updateSelectValue(field: MediaField, raw: string) {
  const option = fieldOptions(field).find(value => String(value) === raw);
  updateTypedField(field, option === undefined ? raw : option);
}

function changeMode(value: 'text' | 'image' | 'video' | 'audio') {
  studio.setMode(value);
  submitError.value = '';
  fieldErrors.value = {};
}

const diagnosticStepLabel = (step: string) => ({
  configuration: 'Конфигурация ключа', authorization: 'Авторизация Kie', tariffs: 'Тарифный API',
  'model-price': 'Цена выбранной модели', quote: 'Расчёт в форме',
}[step] || step);
const diagnosticMechanismLabel = (key: string) => ({ credentials: 'Ключ', authorization: 'Проверка доступа', tariffs: 'Тарифы', generation: 'Генерация' }[key] || key);
const diagnosticTime = (value: string) => new Date(value).toLocaleTimeString('ru-RU');
async function openDiagnostics() {
  if (diagnosticLoading.value) return;
  const modelId = studio.mediaModelId;
  const revision = quoteRevision;
  diagnosticOpen.value = true;
  diagnosticLoading.value = true;
  diagnosticError.value = '';
  diagnostics.value = null;
  try {
    const result = await diagnoseProvider(modelId, mediaRequestInput());
    diagnostics.value = result;
    if (result.ok && result.quote?.credits != null && revision === quoteRevision && studio.provider === 'media' && studio.mediaModelId === modelId) {
      stopQuoteTimer();
      quoteRevision++;
      quote.value = { credits: Number(result.quote.credits) };
      quoteError.value = '';
      quoteLoading.value = false;
    }
  } catch (error) {
    diagnosticError.value = error instanceof Error ? error.message : 'Не удалось получить диагностику';
  } finally { diagnosticLoading.value = false; }
}

watch(() => studio.currentMediaModel?.id, () => {
  const allowed = new Set(currentFields.value.map(field => field.key));
  const defaults = Object.fromEntries(currentFields.value.flatMap(field => {
    if (field.default !== undefined) return [[field.key, field.default]];
    if (field.required && field.type === 'boolean') return [[field.key, false]];
    const firstOption = fieldOptions(field)[0];
    return firstOption === undefined ? [] : [[field.key, parseMediaFieldValue(field, firstOption)]];
  }));
  const current = Object.fromEntries(Object.entries(studio.mediaInput).filter(([key]) => allowed.has(key)));
  studio.mediaInput = { ...defaults, ...current };
  fieldErrors.value = Object.fromEntries(Object.entries(fieldErrors.value).filter(([key]) => allowed.has(key)));
}, { immediate: true });
watch(() => [studio.mode, studio.provider], () => { submitError.value = ''; fieldErrors.value = {}; });
watch(() => studio.providerDiagnosticRequest, (request, previous) => { if (request > previous) void openDiagnostics(); });

function stopQuoteTimer() {
  if (quoteTimer === null) return;
  clearTimeout(quoteTimer);
  quoteTimer = null;
}

function quoteRequestReady() {
  if (studio.provider === 'codex') return Boolean(studio.codexModel && studio.codexEffort);
  return Boolean(studio.mediaModelId && !missingRequiredFields.value.length);
}

async function refreshQuote(revision: number) {
  try {
    if (studio.provider === 'codex') {
      if (!studio.codexModel || !studio.codexEffort) return;
      const result = await getCodexQuote(studio.codexModel, studio.codexEffort, studio.codexSpeed);
      if (revision === quoteRevision) { quote.value = result.quote; quoteError.value = result.error || ''; }
    } else if (studio.mediaModelId) {
      const requestQuote = () => getMediaQuote(studio.mediaModelId, mediaRequestInput());
      let result;
      try { result = await requestQuote(); }
      catch (error) {
        if (!retryableQuoteError(error)) throw error;
        await new Promise(resolve => setTimeout(resolve, 500));
        if (revision !== quoteRevision) return;
        result = await requestQuote();
      }
      if (revision === quoteRevision) quote.value = result;
    }
  } catch (error) {
    if (revision === quoteRevision) { quote.value = null; quoteError.value = error instanceof Error ? error.message : 'Цена недоступна'; }
  } finally {
    if (revision === quoteRevision) quoteLoading.value = false;
  }
}

function scheduleQuoteRefresh(delay = 0) {
  stopQuoteTimer();
  const revision = ++quoteRevision;
  quote.value = null;
  quoteError.value = '';
  quoteLoading.value = quoteRequestReady();
  if (!quoteLoading.value) return;
  quoteTimer = setTimeout(() => {
    quoteTimer = null;
    if (revision === quoteRevision) void refreshQuote(revision);
  }, delay);
}

watch(() => [studio.provider, studio.codexModel, studio.codexEffort, studio.codexSpeed, studio.mediaModelId, studio.mediaInput], () => scheduleQuoteRefresh(), { immediate: true, deep: true });
watch(() => studio.prompt, () => {
  if (studio.provider === 'media') scheduleQuoteRefresh(QUOTE_DEBOUNCE_MS);
});
function hasDraggedFiles(event: DragEvent) {
  return Array.from(event.dataTransfer?.types || []).includes('Files');
}
function matchesAccept(file: File, accept?: string) {
  const accepted = String(accept || '').split(',').map(value => value.trim().toLowerCase().replace(/\.+$/, '')).filter(Boolean);
  if (!accepted.length) return true;
  const mime = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  return accepted.some(value => value.startsWith('.') ? name.endsWith(value) : value.endsWith('/*') ? mime.startsWith(value.slice(0, -1)) : mime === value);
}
function dropAccept(field?: MediaField) {
  return field?.accept || (studio.provider === 'codex' ? 'image/png,image/jpeg,image/webp' : '');
}
function onWindowDragEnter(event: DragEvent) {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
  draggingFiles.value = true;
}
function onWindowDragOver(event: DragEvent) {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = dropReady.value ? 'copy' : 'none';
  draggingFiles.value = true;
}
function onWindowDragLeave(event: DragEvent) {
  if (event.relatedTarget === null) { draggingFiles.value = false; activeDropFieldKey.value = ''; }
}
function closeDropOverlay() {
  draggingFiles.value = false;
  activeDropFieldKey.value = '';
}
function onWindowDrop(event: DragEvent) {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
  const files = [...(event.dataTransfer?.files || [])];
  closeDropOverlay();
  if (!dropReady.value) {
    submitError.value = !studio.accountReady
      ? 'Дождитесь загрузки чата перед добавлением файла'
      : uploading.value
        ? 'Дождитесь завершения текущей загрузки'
        : 'Выбранная модель не поддерживает исходные файлы';
    return;
  }
  if (dropFields.value.length > 1) {
    submitError.value = 'Укажите назначение файла: перетащите его в одну из областей загрузки';
    return;
  }
  void uploadFiles(files, dropFields.value[0]);
}
function dropIntoField(event: DragEvent, field: MediaField) {
  event.preventDefault();
  event.stopPropagation();
  const files = [...(event.dataTransfer?.files || [])];
  closeDropOverlay();
  void uploadFiles(files, field);
}

onMounted(() => {
  window.addEventListener('dragenter', onWindowDragEnter);
  window.addEventListener('dragover', onWindowDragOver);
  window.addEventListener('dragleave', onWindowDragLeave);
  window.addEventListener('drop', onWindowDrop);
});
onBeforeUnmount(() => {
  stopQuoteTimer(); quoteRevision++;
  window.removeEventListener('dragenter', onWindowDragEnter);
  window.removeEventListener('dragover', onWindowDragOver);
  window.removeEventListener('dragleave', onWindowDragLeave);
  window.removeEventListener('drop', onWindowDrop);
});

async function addFiles(event: Event, field?: MediaField) {
  const input = event.target as HTMLInputElement;
  const files = [...(input.files || [])];
  await uploadFiles(files, field);
  input.value = '';
}
async function uploadFiles(files: File[], field?: MediaField) {
  if (!files.length || uploading.value) return;
  uploading.value = true; submitError.value = '';
  try {
    const fieldFiles = studio.sourceFiles.filter(item => item.fieldKey === field?.key).length;
    const maxFiles = field ? (field.scalar ? 1 : field.maxFiles) : 10;
    if (maxFiles && fieldFiles + files.length > maxFiles) throw new Error(`Можно добавить не более ${maxFiles} файлов`);
    const accept = dropAccept(field);
    const invalid = files.find(file => !matchesAccept(file, accept));
    if (invalid) throw new Error(`${invalid.name}: формат файла не поддерживается выбранной моделью`);
    const added = [];
    for (const file of files) {
      const maxSizeMb = field?.maxSizeMb || (field ? undefined : 30);
      if (maxSizeMb && file.size > maxSizeMb * 1024 * 1024) throw new Error(file.name + ': превышен лимит ' + maxSizeMb + ' МБ');
      const saved = await uploadSource(file, { projectId: studio.activeProjectId, chatId: studio.activeChatId === 'system:recent' ? null : studio.activeChatId });
      const item = { ...saved, ref: saved.ref, name: file.name, type: file.type, fieldKey: field?.key };
      studio.sourceFiles.push(item); added.push(item.ref);
    }
    if (field) updateField(field.key, field.scalar || field.maxFiles === 1 ? added.at(-1) : [...(Array.isArray(studio.mediaInput[field.key]) ? studio.mediaInput[field.key] as string[] : []), ...added]);
  } catch (error) { submitError.value = error instanceof Error ? error.message : 'Не удалось загрузить исходник'; }
  finally { uploading.value = false; }
}
function removeFile(index: number) {
  const item = studio.sourceFiles[index]; studio.sourceFiles.splice(index, 1);
  if (item.fieldKey) {
    const remaining = studio.sourceFiles.filter(file => file.fieldKey === item.fieldKey).map(file => file.ref);
    updateField(item.fieldKey, remaining.length > 1 ? remaining : remaining[0] || undefined);
  }
}
function animateToQueue(event?: Event) {
  const eventElement = event?.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  const origin = eventElement?.classList.contains('generate-button') ? eventElement : document.querySelector<HTMLElement>('.generate-button');
  const queue = document.querySelector<HTMLElement>('.queue-card');
  const toggle = document.querySelector<HTMLElement>('.results-toggle');
  if (!origin) return;
  const queueRect = queue?.getBoundingClientRect();
  const queueIsVisible = Boolean(queueRect && queueRect.width > 0 && queueRect.height > 0 && queueRect.left < window.innerWidth && queueRect.right > 0);
  const target = queueIsVisible ? queue : toggle;
  if (!target) return;
  const from = origin.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  const flight = document.createElement('span');
  flight.className = 'queue-flight';
  flight.textContent = studio.mode === 'video' ? '▹' : studio.mode === 'audio' ? '⌁' : studio.mode === 'text' ? '▢' : '▧';
  flight.style.left = `${from.left + from.width / 2 - 18}px`;
  flight.style.top = `${from.top + from.height / 2 - 18}px`;
  document.body.append(flight);
  const deltaX = to.left + to.width / 2 - (from.left + from.width / 2);
  const deltaY = to.top + Math.min(42, to.height / 2) - (from.top + from.height / 2);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const animation = flight.animate([
    { transform: 'translate3d(0, 0, 0) scale(1)', opacity: 1 },
    { transform: `translate3d(${deltaX * .52}px, ${deltaY * .38 - 54}px, 0) scale(.82)`, opacity: .92, offset: .55 },
    { transform: `translate3d(${deltaX}px, ${deltaY}px, 0) scale(.18)`, opacity: .12 },
  ], { duration: reducedMotion ? 1 : 620, easing: 'cubic-bezier(.2,.8,.25,1)', fill: 'forwards' });
  animation.finished.catch(() => {}).finally(() => {
    flight.remove();
    target.animate([{ boxShadow: '0 0 0 0 rgba(143,117,255,0)' }, { boxShadow: '0 0 0 5px rgba(143,117,255,.22)' }, { boxShadow: '0 0 0 0 rgba(143,117,255,0)' }], { duration: reducedMotion ? 1 : 360 });
  });
}
async function submit(event?: Event) {
  if (hasFieldErrors.value) { submitError.value = 'Исправьте параметры с ошибками'; return; }
  if (missingRequiredFields.value.length) { submitError.value = 'Заполните обязательные параметры'; return; }
  if (!quote.value) { submitError.value = quoteError.value || 'Дождитесь расчёта стоимости'; return; }
  if (!studio.prompt.trim()) { submitError.value = 'Введите промпт'; return; }
  submitError.value = '';
  animateToQueue(event);
  try { await studio.submit(); } catch (error) { submitError.value = error instanceof Error ? error.message : 'Не удалось запустить генерацию'; }
}
</script>

<template>
  <section class="composer-card">
    <div class="composer-tabs">
      <button v-for="item in [{ id: 'text', label: 'Текст', icon: '▢' }, { id: 'image', label: 'Изображение', icon: '▧' }, { id: 'video', label: 'Видео', icon: '▹' }, { id: 'audio', label: 'Аудио', icon: '⌁' }]" :key="item.id" type="button" :class="{ active: studio.mode === item.id }" @click="changeMode(item.id as 'text' | 'image' | 'video' | 'audio')">{{ item.icon }} {{ item.label }}</button>
    </div>
    <div class="composer-body">
      <p v-if="studio.provider === 'media' && studio.mode === 'audio' && !modelOptions.length" class="notice" role="status">Аудиомодели пока недоступны.</p>
      <textarea v-if="showsPrompt" v-model="promptValue" maxlength="20000" :placeholder="promptPlaceholder" aria-label="Промпт генерации" @keydown.ctrl.enter="submit"></textarea>
      <div v-if="hasSourcePicker || studio.sourceFiles.length || uploading" class="source-strip">
        <label v-if="studio.provider === 'codex' && codexAcceptsImages" class="attach-button">＋ Исходники<input type="file" accept="image/png,image/jpeg,image/webp" multiple @change="addFiles($event)" /></label>
        <label v-for="field in fileFields" v-else :key="field.key" class="attach-button">＋ {{ sourceButtonLabel(field) }}{{ field.required ? ' *' : '' }}<input type="file" :accept="field.accept" :multiple="!field.scalar && field.maxFiles !== 1" @change="addFiles($event, field)" /></label>
        <span v-if="uploading" class="uploading">Загрузка…</span>
        <article v-for="(file, index) in studio.sourceFiles" :key="file.ref + index" class="source-preview">
          <img v-if="isImageSource(file.type)" :src="sourcePreviewUrl(file.ref)" :alt="`Миниатюра ${file.name}`" loading="lazy">
          <span v-else class="source-file-icon" aria-hidden="true">▧</span>
          <span class="source-preview-copy"><strong>{{ file.name }}</strong><small>{{ sourceFieldLabel(file.fieldKey) || 'Исходное изображение' }}</small></span>
          <button type="button" class="source-remove" :aria-label="`Удалить ${file.name}`" @click="removeFile(index)">×</button>
        </article>
      </div>
      <div class="composer-controls">
        <PresetBar />
        <ModelCatalogPicker v-model="modelChoice" :models="modelOptions" :price="selectedModelPrice" />
        <template v-if="studio.provider === 'codex'">
          <label class="select-pill"><span>Рассуждение</span><select v-model="studio.codexEffort"><option v-for="effort in effortOptions" :key="effort" :value="effort">{{ effort }}</option></select></label>
          <AspectRatioPicker v-if="studio.mode === 'image'" v-model="studio.codexAspectRatio" label="Формат" :options="['auto', '1:1', '16:9', '9:16', '3:2', '2:3']" />
          <label class="select-pill"><span>Скорость</span><select v-model="studio.codexSpeed"><option value="standard">Обычная</option><option value="fast">⚡ Fast</option></select></label>
        </template>
        <template v-for="field in primaryFields" v-else :key="field.key">
          <AspectRatioPicker v-if="isAspectRatioField(field.key)" :model-value="String(fieldValue(field))" :label="field.label || 'Формат'" :options="fieldOptions(field)" @update:model-value="updateSelectValue(field, $event)" />
          <label v-else class="select-pill"><span>{{ field.label || field.key }}{{ field.required ? ' *' : '' }}</span><select :value="fieldValue(field)" @change="updateSelect(field, $event)"><option v-for="option in fieldOptions(field)" :key="String(option)" :value="String(option)">{{ fieldOptionLabel(field, option) }}</option></select></label>
        </template>
        <span v-if="quoteError" class="quote-error-wrap"><span class="quote error">{{ quoteError }}</span><button type="button" class="details-button" @click="openDiagnostics">Детали</button></span>
        <button class="generate-button" :class="{ 'is-loading': quoteLoading }" type="button" :aria-busy="quoteLoading" :disabled="quoteLoading || uploading || !modelOptions.length || total === null || hasFieldErrors || missingRequiredFields.length > 0" @click="submit"><span v-if="quoteLoading" class="generate-spinner" aria-hidden="true"></span>{{ quoteLoading ? 'Расчёт…' : 'Генерировать' }}<span v-if="!quoteLoading && total !== null"> · {{ total.toLocaleString('ru-RU') }}</span> <span v-if="!quoteLoading" aria-hidden="true">↗</span></button>
      </div>
      <details v-if="studio.provider === 'media' && extraFields.length" class="advanced-settings"><summary>Дополнительные параметры</summary><div class="advanced-grid"><label v-for="field in extraFields" :key="field.key" :class="{ invalid: fieldErrors[field.key] }"><span>{{ field.label || field.key }}{{ field.required ? ' *' : '' }}</span><select v-if="fieldOptions(field).length" :value="fieldValue(field)" @change="updateSelect(field, $event)"><option v-for="option in fieldOptions(field)" :key="String(option)" :value="String(option)">{{ fieldOptionLabel(field, option) }}</option></select><input v-else-if="field.type === 'number'" type="number" :min="field.min" :max="field.max" :step="field.step" :value="fieldValue(field)" @input="updateTypedField(field, ($event.target as HTMLInputElement).value)" /><input v-else-if="field.type === 'boolean'" type="checkbox" :checked="Boolean(fieldValue(field))" @change="updateTypedField(field, ($event.target as HTMLInputElement).checked)" /><textarea v-else-if="field.type === 'textarea' || field.type === 'json'" :maxlength="field.maxLength" :value="String(fieldValue(field))" @change="updateTypedField(field, ($event.target as HTMLTextAreaElement).value)"></textarea><input v-else type="text" :maxlength="field.maxLength" :value="String(fieldValue(field))" @input="updateTypedField(field, ($event.target as HTMLInputElement).value)" /><small v-if="fieldErrors[field.key]" class="field-error">{{ fieldErrors[field.key] }}</small><small v-else-if="field.hint">{{ field.hint }}</small></label></div></details>
      <p v-if="missingRequiredFields.length" class="form-error">Заполните обязательные параметры: {{ missingRequiredFields.map(field => field.label || field.key).join(', ') }}</p>
      <p v-if="submitError" class="form-error" role="alert">{{ submitError }}</p>
      <p class="composer-hint">Ctrl + Enter — запустить · черновик сохраняется в текущем чате</p>
    </div>
    <Teleport to="body">
      <div v-if="draggingFiles" class="chat-drop-overlay" :class="{ unavailable: !dropReady }" @dragover.prevent>
        <section class="chat-drop-panel" role="status" aria-live="assertive">
          <span class="chat-drop-icon" aria-hidden="true">⇩</span>
          <strong>{{ dropTitle }}</strong>
          <p>{{ dropDescription }}</p>
          <div v-if="dropReady && dropFields.length > 1" class="chat-drop-targets">
            <article
              v-for="field in dropFields"
              :key="field.key"
              class="chat-drop-target"
              :class="{ active: activeDropFieldKey === field.key }"
              @dragenter.prevent="activeDropFieldKey = field.key"
              @dragleave="activeDropFieldKey = ''"
              @dragover.prevent
              @drop="dropIntoField($event, field)"
            >
              <strong>{{ field.label || field.key }}</strong>
              <small>{{ field.scalar || field.maxFiles === 1 ? 'Один файл' : field.maxFiles ? `До ${field.maxFiles} файлов` : 'Несколько файлов' }}</small>
            </article>
          </div>
        </section>
      </div>
      <div v-if="diagnosticOpen" class="diagnostic-backdrop" @click.self="diagnosticOpen = false">
        <section class="diagnostic-dialog" role="dialog" aria-modal="true" aria-label="Диагностика Kie.ai">
          <header><div><span class="eyebrow">ДИАГНОСТИКА ПРОВАЙДЕРА</span><h2>Kie.ai</h2></div><button type="button" class="dialog-close" aria-label="Закрыть" @click="diagnosticOpen = false">×</button></header>
          <div v-if="diagnosticLoading" class="diagnostic-loading">Проверяю серверный ключ, авторизацию и тариф модели…</div>
          <div v-else-if="diagnosticError" class="diagnostic-summary error"><strong>Сервис диагностики недоступен</strong><span>{{ diagnosticError }}</span></div>
          <template v-else-if="diagnostics">
            <div class="diagnostic-summary" :class="diagnostics.ok ? 'success' : 'error'">
              <strong>{{ diagnostics.ok ? 'Все проверки пройдены' : 'Найдена ошибка' }}</strong>
              <span>{{ diagnostics.model.name || diagnostics.model.id }}<template v-if="diagnostics.quote?.credits != null"> · {{ diagnostics.quote.credits }} кредитов</template></span>
            </div>
            <div class="diagnostic-checks">
              <article v-for="item in diagnostics.checks" :key="item.time + item.step" :class="item.status">
                <span class="diagnostic-mark">{{ item.status === 'ok' ? '✓' : '!' }}</span>
                <div><strong>{{ diagnosticStepLabel(item.step) }}</strong><p>{{ item.message }}</p></div>
                <time>{{ item.durationMs }} мс</time>
              </article>
            </div>
            <details class="diagnostic-mechanism" open><summary>Механизм запросов</summary><dl><template v-for="(value, key) in diagnostics.mechanism" :key="key"><dt>{{ diagnosticMechanismLabel(key) }}</dt><dd>{{ value }}</dd></template></dl></details>
            <details class="diagnostic-log" open><summary>Последние записи журнала</summary><ol><li v-for="(item, index) in diagnostics.recentLogs" :key="item.time + item.step + index" :class="item.status"><time>{{ diagnosticTime(item.time) }}</time><strong>{{ diagnosticStepLabel(item.step) }}</strong><span>{{ item.message }}</span><em>{{ item.durationMs }} мс</em></li></ol></details>
          </template>
          <footer><button type="button" class="secondary-button" :disabled="diagnosticLoading" @click="openDiagnostics">Повторить проверку</button><button type="button" class="primary-button" @click="diagnosticOpen = false">Закрыть</button></footer>
        </section>
      </div>
    </Teleport>
  </section>
</template>
