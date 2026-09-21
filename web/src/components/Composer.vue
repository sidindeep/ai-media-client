<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useStudioStore } from '../stores/studio';
import { diagnoseProvider, getCodexQuote, getMediaQuote, uploadSource } from '../api/client';
import type { ProviderDiagnostics } from '../api/client';
import type { MediaField } from '../types';
import ProviderSelector from './ProviderSelector.vue';
import ModelCatalogPicker from './ModelCatalogPicker.vue';
import { formatMediaFieldValue, mediaFieldOptions, parseMediaFieldValue } from '../domain/media-fields';
import { mediaModelBrandId } from '../domain/model-catalog';

const studio = useStudioStore();
const sending = ref(false);
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
let quoteRevision = 0;
let quoteTimer: ReturnType<typeof setTimeout> | null = null;
const QUOTE_DEBOUNCE_MS = 1500;
const effortOptions = computed(() => studio.currentCodexModel?.efforts || ['low', 'medium', 'high']);
const currentFields = computed(() => studio.currentMediaModel?.fields || []);
const fileFields = computed(() => currentFields.value.filter(field => field.type === 'files'));
const codexAcceptsImages = computed(() => studio.currentCodexModel?.inputModalities?.includes('image') === true);
const hasSourcePicker = computed(() => studio.provider === 'codex' ? codexAcceptsImages.value : fileFields.value.length > 0);
const primaryFields = computed(() => currentFields.value.filter(field => /aspect|ratio|format|resolution|quality/i.test(field.key) && (field.options?.length || field.schema?.enum?.length)).slice(0, 2));
const extraFields = computed(() => currentFields.value.filter(field => !/prompt/i.test(field.key) && field.type !== 'files' && !primaryFields.value.includes(field)));
const total = computed(() => quote.value ? quote.value.credits * studio.quantity : null);
const mediaProviderName = computed(() => studio.catalog?.providers.find(provider => provider.id === 'media')?.name || 'Kie.ai');
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
const selectedModelPrice = computed(() => quote.value ? `${quote.value.credits.toLocaleString('ru-RU')} кр.` : undefined);
const hasFieldErrors = computed(() => Object.keys(fieldErrors.value).length > 0);
const missingRequiredFields = computed(() => studio.provider === 'media' ? currentFields.value.filter(field => {
  if (!field.required || /prompt/i.test(field.key)) return false;
  const value = studio.mediaInput[field.key];
  return value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length);
}) : []);
const retryableQuoteError = (error: unknown) => error instanceof Error
  && /^(?:Не удалось выполнить запрос|Некорректный ответ сервиса|Связь с базой данных временно недоступна)/i.test(error.message);

function fieldOptions(field: MediaField) { return mediaFieldOptions(field); }
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
  const raw = (event.target as HTMLSelectElement).value;
  const option = fieldOptions(field).find(value => String(value) === raw);
  updateTypedField(field, option === undefined ? raw : option);
}

function changeProvider(value: 'codex' | 'media') {
  studio.setProvider(value);
  submitError.value = '';
}

function changeMode(value: 'text' | 'image' | 'video' | 'audio') {
  const previousModel = studio.mediaModelId;
  studio.setMode(value);
  if (previousModel !== studio.mediaModelId) { studio.mediaInput = {}; studio.sourceFiles = []; fieldErrors.value = {}; }
}

const diagnosticStepLabel = (step: string) => ({
  configuration: 'Конфигурация ключа', authorization: 'Авторизация Kie', tariffs: 'Тарифный API',
  'model-price': 'Цена выбранной модели', quote: 'Расчёт в форме',
}[step] || step);
const diagnosticMechanismLabel = (key: string) => ({ credentials: 'Ключ', authorization: 'Проверка доступа', tariffs: 'Тарифы', generation: 'Генерация' }[key] || key);
const diagnosticTime = (value: string) => new Date(value).toLocaleTimeString('ru-RU');
async function openDiagnostics() {
  const modelId = studio.mediaModelId;
  const revision = quoteRevision;
  diagnosticOpen.value = true;
  diagnosticLoading.value = true;
  diagnosticError.value = '';
  diagnostics.value = null;
  try {
    const result = await diagnoseProvider(modelId, { ...studio.mediaInput, prompt: studio.prompt });
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
    const firstOption = fieldOptions(field)[0];
    return firstOption === undefined ? [] : [[field.key, parseMediaFieldValue(field, firstOption)]];
  }));
  const current = Object.fromEntries(Object.entries(studio.mediaInput).filter(([key]) => allowed.has(key)));
  studio.mediaInput = { ...defaults, ...current };
  fieldErrors.value = Object.fromEntries(Object.entries(fieldErrors.value).filter(([key]) => allowed.has(key)));
}, { immediate: true });

function stopQuoteTimer() {
  if (quoteTimer === null) return;
  clearTimeout(quoteTimer);
  quoteTimer = null;
}

function quoteRequestReady() {
  if (studio.provider === 'codex') return Boolean(studio.codexModel && studio.codexEffort);
  return Boolean(studio.mediaModelId && studio.prompt.trim());
}

async function refreshQuote(revision: number) {
  try {
    if (studio.provider === 'codex') {
      if (!studio.codexModel || !studio.codexEffort) return;
      const result = await getCodexQuote(studio.codexModel, studio.codexEffort, studio.codexSpeed);
      if (revision === quoteRevision) { quote.value = result.quote; quoteError.value = result.error || ''; }
    } else if (studio.mediaModelId) {
      const requestQuote = () => getMediaQuote(studio.mediaModelId, { ...studio.mediaInput, prompt: studio.prompt });
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
onBeforeUnmount(() => { stopQuoteTimer(); quoteRevision++; });

async function addFiles(event: Event, field?: MediaField) {
  const input = event.target as HTMLInputElement;
  const files = [...(input.files || [])];
  if (!files.length) return;
  uploading.value = true; submitError.value = '';
  try {
    const fieldFiles = studio.sourceFiles.filter(item => item.fieldKey === field?.key).length;
    const maxFiles = field ? (field.scalar ? 1 : field.maxFiles) : 10;
    if (maxFiles && fieldFiles + files.length > maxFiles) throw new Error(`Можно добавить не более ${maxFiles} файлов`);
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
  if (hasFieldErrors.value) { submitError.value = 'Исправьте параметры с ошибками'; return; }
  if (missingRequiredFields.value.length) { submitError.value = 'Заполните обязательные параметры'; return; }
  if (!quote.value) { submitError.value = quoteError.value || 'Дождитесь расчёта стоимости'; return; }
  sending.value = true; submitError.value = '';
  try { await studio.submit(); } catch (error) { submitError.value = error instanceof Error ? error.message : 'Не удалось запустить генерацию'; } finally { sending.value = false; }
}
</script>

<template>
  <section class="composer-card">
    <div class="composer-tabs">
      <button v-for="item in [{ id: 'text', label: 'Текст', icon: '▢' }, { id: 'image', label: 'Изображение', icon: '▧' }, { id: 'video', label: 'Видео', icon: '▹' }, { id: 'audio', label: 'Аудио', icon: '⌁' }]" :key="item.id" type="button" :class="{ active: studio.mode === item.id }" @click="changeMode(item.id as 'text' | 'image' | 'video' | 'audio')">{{ item.icon }} {{ item.label }}</button>
    </div>
    <div class="composer-body">
      <ProviderSelector :model-value="studio.provider" :media-label="mediaProviderName" @update:model-value="changeProvider" />
      <div v-if="studio.provider === 'media'" class="provider-diagnostic-actions">
        <button type="button" class="kie-test-button" :disabled="diagnosticLoading" @click="openDiagnostics">{{ diagnosticLoading ? 'Проверка…' : 'Проверить Kie' }}</button>
        <span>Проверяет ключ, авторизацию и цену. Генерация не запускается.</span>
      </div>
      <textarea v-model="studio.prompt" maxlength="20000" placeholder="Введите идею для генерации" aria-label="Промпт генерации" @keydown.ctrl.enter="submit"></textarea>
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
        <ModelCatalogPicker v-model="modelChoice" :models="modelOptions" :price="selectedModelPrice" />
        <template v-if="studio.provider === 'codex'">
          <label class="select-pill"><span>Рассуждение</span><select v-model="studio.codexEffort"><option v-for="effort in effortOptions" :key="effort" :value="effort">{{ effort }}</option></select></label>
          <label v-if="studio.mode === 'image'" class="select-pill"><span>Формат</span><select v-model="studio.codexAspectRatio"><option value="auto">Авто</option><option value="1:1">1:1</option><option value="16:9">16:9</option><option value="9:16">9:16</option><option value="3:2">3:2</option><option value="2:3">2:3</option></select></label>
          <label class="select-pill"><span>Скорость</span><select v-model="studio.codexSpeed"><option value="standard">Обычная</option><option value="fast">⚡ Fast</option></select></label>
        </template>
        <label v-for="field in primaryFields" v-else :key="field.key" class="select-pill"><span>{{ field.label || field.key }}{{ field.required ? ' *' : '' }}</span><select :value="fieldValue(field)" @change="updateSelect(field, $event)"><option v-for="option in fieldOptions(field)" :key="String(option)" :value="String(option)">{{ option }}</option></select></label>
        <label class="select-pill"><span>Количество</span><select v-model.number="studio.quantity"><option v-for="count in 4" :key="count" :value="count">{{ count }} шт.</option></select></label>
        <span v-if="total !== null" class="quote">Итого: {{ total.toLocaleString('ru-RU') }} кредитов</span>
        <span v-else-if="quoteError" class="quote-error-wrap"><span class="quote error">{{ quoteError }}</span><button type="button" class="details-button" @click="openDiagnostics">Детали</button></span>
        <button class="generate-button" :class="{ 'is-loading': quoteLoading || sending }" type="button" :aria-busy="quoteLoading || sending" :disabled="sending || quoteLoading || uploading || !studio.prompt.trim() || !modelOptions.length || total === null || hasFieldErrors || missingRequiredFields.length > 0" @click="submit"><span v-if="quoteLoading || sending" class="generate-spinner" aria-hidden="true"></span>{{ quoteLoading ? 'Расчёт…' : sending ? 'Запуск…' : 'Генерировать' }}<span v-if="!quoteLoading && total !== null"> · {{ total.toLocaleString('ru-RU') }}</span> <span v-if="!quoteLoading && !sending" aria-hidden="true">↗</span></button>
      </div>
      <details v-if="studio.provider === 'media' && extraFields.length" class="advanced-settings"><summary>Дополнительные параметры</summary><div class="advanced-grid"><label v-for="field in extraFields" :key="field.key" :class="{ invalid: fieldErrors[field.key] }"><span>{{ field.label || field.key }}{{ field.required ? ' *' : '' }}</span><select v-if="fieldOptions(field).length" :value="fieldValue(field)" @change="updateSelect(field, $event)"><option v-for="option in fieldOptions(field)" :key="String(option)" :value="String(option)">{{ option }}</option></select><input v-else-if="field.type === 'number'" type="number" :min="field.min" :max="field.max" :step="field.step" :value="fieldValue(field)" @input="updateTypedField(field, ($event.target as HTMLInputElement).value)" /><input v-else-if="field.type === 'boolean'" type="checkbox" :checked="Boolean(fieldValue(field))" @change="updateTypedField(field, ($event.target as HTMLInputElement).checked)" /><textarea v-else-if="field.type === 'textarea' || field.type === 'json'" :maxlength="field.maxLength" :value="String(fieldValue(field))" @change="updateTypedField(field, ($event.target as HTMLTextAreaElement).value)"></textarea><input v-else type="text" :maxlength="field.maxLength" :value="String(fieldValue(field))" @input="updateTypedField(field, ($event.target as HTMLInputElement).value)" /><small v-if="fieldErrors[field.key]" class="field-error">{{ fieldErrors[field.key] }}</small><small v-else-if="field.hint">{{ field.hint }}</small></label></div></details>
      <p v-if="missingRequiredFields.length" class="form-error">Заполните обязательные параметры: {{ missingRequiredFields.map(field => field.label || field.key).join(', ') }}</p>
      <p v-if="submitError" class="form-error" role="alert">{{ submitError }}</p>
      <p class="composer-hint">Ctrl + Enter — запустить · черновик сохраняется в текущем чате</p>
    </div>
    <Teleport to="body">
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
