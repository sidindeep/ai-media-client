<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useStudioStore } from '../stores/studio';
import { diagnoseProvider, getCodexQuote, getMediaQuote, getRouterAiQuote, uploadSource } from '../api/client';
import type { ProviderDiagnostics } from '../api/client';
import type { MediaField } from '../types';
import ModelCatalogPicker from './ModelCatalogPicker.vue';
import AspectRatioPicker from './AspectRatioPicker.vue';
import PresetBar from './PresetBar.vue';
import { formatMediaFieldValue, mediaFieldOptions, mediaFieldValueError, mediaSourceDurationRange, parseMediaFieldValue } from '../domain/media-fields';
import { mediaModelBrandId, routerAiModelBrandId } from '../domain/model-catalog';
import { publicServiceError } from '../domain/result-presentation';
import { aspectRatioName, isAspectRatioField } from '../domain/aspect-ratios';
import { formatCreditCost, roundedCreditCost } from '../domain/credits';
import { useI18n } from '../i18n';

const studio = useStudioStore();
const { formatDate, formatNumber, t } = useI18n();
const modeItems = computed(() => [
  { id: 'text', label: t('composer.mode.text'), icon: '▢' },
  { id: 'image', label: t('composer.mode.image'), icon: '▧' },
  ...(studio.fullModelAccess ? [{ id: 'video', label: t('composer.mode.video'), icon: '▹' }, { id: 'audio', label: t('composer.mode.audio'), icon: '⌁' }] : []),
] as Array<{ id: 'text' | 'image' | 'video' | 'audio'; label: string; icon: string }>);
const uploading = ref(false);
const submitError = ref('');
const quote = ref<{ credits: number; amountUnits?: number } | null>(null);
const quoteError = ref('');
const quoteLoading = ref(false);
const diagnosticOpen = ref(false);
const diagnosticLoading = ref(false);
const diagnosticError = ref('');
const diagnostics = ref<ProviderDiagnostics | null>(null);
const fieldErrors = ref<Record<string, string>>({});
const routerAiExtra = ref('{}');
const routerAiVideoDuration = ref<number | null>(null);
const routerAiVideoResolution = ref('');
const routerAiVideoAspectRatio = ref('');
const routerAiAudioFile = ref<File | null>(null);
const routerAiSpecial = computed(() => studio.provider === 'routerai' && studio.isAdmin
  && Boolean(studio.currentRouterAiModel) && !['text', 'image'].includes(studio.currentRouterAiModel!.kind));
const draggingFiles = ref(false);
const activeDropFieldKey = ref('');
let quoteRevision = 0;
let quoteTimer: ReturnType<typeof setTimeout> | null = null;
const QUOTE_DEBOUNCE_MS = 1500;
const effortOptions = computed(() => studio.currentCodexModel?.efforts || ['low', 'medium', 'high']);
const currentFields = computed(() => studio.currentMediaModel?.fields || []);
const fileFields = computed(() => currentFields.value.filter(field => field.type === 'files'));
const codexAcceptsImages = computed(() => studio.currentCodexModel?.inputModalities?.includes('image') === true);
const hasSourcePicker = computed(() => studio.provider === 'codex' ? codexAcceptsImages.value : studio.provider === 'media' && fileFields.value.length > 0);
const dropFields = computed(() => studio.provider === 'media' ? fileFields.value : []);
const dropReady = computed(() => studio.accountReady && !uploading.value && hasSourcePicker.value);
const dropTitle = computed(() => {
  if (!studio.accountReady) return t('composer.drop.chatLoading');
  if (uploading.value) return t('composer.drop.uploadPending');
  if (!hasSourcePicker.value) return t('composer.drop.unsupported');
  return dropFields.value.length > 1 ? t('composer.drop.chooseTarget') : t('composer.drop.ready');
});
const dropDescription = computed(() => {
  if (!studio.accountReady) return t('composer.drop.chatLoadingDetail');
  if (uploading.value) return t('composer.drop.uploadPendingDetail');
  if (!hasSourcePicker.value) return t('composer.drop.unsupportedDetail');
  if (dropFields.value.length > 1) return t('composer.drop.chooseTargetDetail');
  const field = dropFields.value[0];
  return field?.label ? t('composer.drop.releaseField', { field: field.label }) : t('composer.drop.releaseChat');
});
const primaryFields = computed(() => currentFields.value.filter(field => /aspect|ratio|format|resolution|quality/i.test(field.key) && (field.options?.length || field.schema?.enum?.length)).slice(0, 2));
const extraFields = computed(() => currentFields.value.filter(field => !/prompt/i.test(field.key) && field.type !== 'files' && !primaryFields.value.includes(field)));
const total = computed(() => quote.value ? roundedCreditCost(quote.value.credits) : null);
const unavailableMediaPrice = computed(() => studio.provider === 'media'
  && /^(?:Цена этой модели Kie ещё не опубликована|Цена выбранных параметров Kie ещё не определена|Единица тарифа Kie пока не поддерживается)/.test(quoteError.value));
const quoteErrorMessage = computed(() => {
  if (!quoteError.value) return '';
  if (!studio.isAdmin) return publicServiceError(quoteError.value, t('composer.quoteRetry'));
  return studio.provider === 'media' && !unavailableMediaPrice.value ? t('composer.quoteRetryKie', { error: quoteError.value }) : quoteError.value;
});
const modelChoice = computed({
  get: () => studio.provider === 'codex' ? studio.codexModel : studio.provider === 'routerai' ? studio.routerAiModel : studio.mediaModelId,
  set: value => {
    if (studio.provider === 'codex') studio.codexModel = value;
    else if (studio.provider === 'routerai') studio.routerAiModel = value;
    else {
      studio.mediaInput = {};
      studio.sourceFiles = [];
      fieldErrors.value = {};
      studio.mediaModelId = value;
    }
  },
});
const modelOptions = computed(() => studio.provider === 'routerai'
  ? studio.routerAiModels.map(model => ({ value: model.id, label: model.name, description: model.description || 'RouterAI', groupId: routerAiModelBrandId(model.id) }))
  : studio.provider === 'codex'
  ? (studio.codexCatalog?.models || []).map(model => ({ value: model.id, label: model.name, description: studio.isAdmin ? t('composer.codexDescriptionAdmin') : t('composer.codexDescription'), groupId: 'codex' }))
  : studio.mediaModels.map(model => ({ value: model.id, label: model.name.trim(), description: model.description, groupId: mediaModelBrandId(model.id, model.name) })));
const promptField = computed(() => studio.provider === 'media' ? currentFields.value.find(field => field.key === 'prompt' || field.key === 'text') : undefined);
const showsPrompt = computed(() => studio.provider !== 'media' || Boolean(promptField.value));
const promptValue = computed({
  get: () => promptField.value?.key === 'text' ? String(studio.mediaInput.text || '') : studio.prompt,
  set: value => { if (promptField.value?.key === 'text') updateField('text', value); else studio.prompt = value; },
});
const promptPlaceholder = computed(() => studio.mode === 'audio'
  ? promptField.value?.key === 'text' ? t('composer.promptVoice') : t('composer.promptAudio')
  : t('composer.promptDefault'));
const selectedModelPrice = computed(() => quote.value ? `${formatCreditCost(quote.value.credits)} ${t('common.creditsShort')}` : undefined);
const valueErrors = computed(() => Object.fromEntries(currentFields.value.flatMap(field => {
  if (field.type === 'files' || /prompt/i.test(field.key)) return [];
  const message = mediaFieldValueError(field, studio.mediaInput[field.key] ?? field.default);
  return message ? [[field.key, message]] : [];
})));
const allFieldErrors = computed(() => ({ ...valueErrors.value, ...fieldErrors.value }));
const hasFieldErrors = computed(() => Object.keys(allFieldErrors.value).length > 0);
const missingRequiredFields = computed(() => studio.provider === 'media' ? currentFields.value.filter(field => {
  if (!field.required) return false;
  if (field.key === 'prompt') return !studio.prompt.trim();
  const value = studio.mediaInput[field.key];
  return value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length);
}) : []);
const mediaRequestInput = () => ({ ...studio.mediaInput, ...(promptField.value?.key === 'prompt' ? { prompt: studio.prompt } : {}) });
const retryableReadError = (error: unknown) => error instanceof Error
  && /^(?:Не удалось выполнить запрос|Некорректный ответ сервиса|Подключаемся к базе данных|Связь с базой данных временно недоступна)/i.test(error.message);

function fieldOptions(field: MediaField) { return mediaFieldOptions(field); }
function fieldOptionLabel(field: MediaField, option: unknown) {
  if (field.key === 'duration' && Number(option) <= 0) return t('composer.auto');
  const name = isAspectRatioField(field.key) ? aspectRatioName(option) : '';
  return name ? `${option} — ${name}` : String(option);
}
function sourceButtonLabel(field: MediaField) { return fileFields.value.length === 1 ? t('composer.sources') : (field.label || t('composer.sources')); }
function sourcePreviewUrl(ref: string) {
  const assetId = /^content:([a-f0-9-]{36})$/.exec(ref)?.[1];
  if (assetId) return `/api/content/${assetId}`;
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
function fieldError(field: MediaField) { return allFieldErrors.value[field.key] || ''; }
function updateTypedField(field: MediaField, raw: unknown) {
  try {
    updateField(field.key, parseMediaFieldValue(field, raw));
    const errors = { ...fieldErrors.value }; delete errors[field.key]; fieldErrors.value = errors;
  } catch (error) {
    fieldErrors.value = { ...fieldErrors.value, [field.key]: error instanceof Error ? error.message : t('composer.invalidValue') };
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
  configuration: t('composer.diagnosticStep.configuration'),
  authorization: t('composer.diagnosticStep.authorization'),
  tariffs: t('composer.diagnosticStep.tariffs'),
  'model-price': t('composer.diagnosticStep.modelPrice'),
  quote: t('composer.diagnosticStep.quote'),
} as Record<string, string>)[step] || step;
const diagnosticMechanismLabel = (key: string) => ({
  credentials: t('composer.diagnosticMechanism.credentials'),
  authorization: t('composer.diagnosticMechanism.authorization'),
  tariffs: t('composer.diagnosticMechanism.tariffs'),
  generation: t('composer.diagnosticMechanism.generation'),
} as Record<string, string>)[key] || key;
const diagnosticTime = (value: string) => formatDate(value, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
async function openDiagnostics() {
  if (diagnosticLoading.value) return;
  const modelId = studio.mediaModelId;
  const revision = quoteRevision;
  diagnosticOpen.value = true;
  diagnosticLoading.value = true;
  diagnosticError.value = '';
  diagnostics.value = null;
  try {
    const selectedKieAccount = studio.kieAccountId;
    const requestDiagnostics = () => diagnoseProvider(modelId, mediaRequestInput(), studio.sourceFiles, selectedKieAccount);
    let result;
    try { result = await requestDiagnostics(); }
    catch (error) {
      if (!retryableReadError(error)) throw error;
      await new Promise(resolve => setTimeout(resolve, 750));
      result = await requestDiagnostics();
    }
    diagnostics.value = result;
    if (result.ok && result.quote?.credits != null && revision === quoteRevision && studio.provider === 'media' && studio.mediaModelId === modelId) {
      stopQuoteTimer();
      quoteRevision++;
      quote.value = { credits: Number(result.quote.credits) };
      quoteError.value = '';
      quoteLoading.value = false;
    }
  } catch (error) {
    diagnosticError.value = error instanceof Error ? error.message : t('composer.diagnosticLoadError');
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
watch(() => studio.currentRouterAiModel?.id, () => {
  routerAiExtra.value = '{}';
  routerAiAudioFile.value = null;
  const model = studio.currentRouterAiModel;
  routerAiVideoDuration.value = model?.supportedDurations?.[0] ?? null;
  routerAiVideoResolution.value = model?.supportedResolutions?.[0] ?? '';
  routerAiVideoAspectRatio.value = model?.supportedAspectRatios?.[0] ?? '';
}, { immediate: true });

function routerAiVideoPayload(prompt: string): Record<string, unknown> {
  return { prompt,
    ...(routerAiVideoDuration.value !== null ? { duration: routerAiVideoDuration.value } : {}),
    ...(routerAiVideoResolution.value ? { resolution: routerAiVideoResolution.value } : {}),
    ...(routerAiVideoAspectRatio.value ? { aspect_ratio: routerAiVideoAspectRatio.value } : {}),
  };
}

async function routerAiPayload(prompt: string): Promise<Record<string, unknown>> {
  const model = studio.currentRouterAiModel;
  if (!model) throw new Error(t('studio.selectModel'));
  if (model.kind === 'video') return routerAiVideoPayload(prompt);
  let extras: unknown;
  try { extras = JSON.parse(routerAiExtra.value); }
  catch { throw new Error(t('routerai.admin.invalidJson')); }
  if (!extras || typeof extras !== 'object' || Array.isArray(extras)) throw new Error(t('routerai.admin.invalidBody'));
  let base: Record<string, unknown>;
  if (model.kind === 'image') base = { prompt };
  else if (model.kind === 'audio' && model.endpoint === 'audio/speech') base = { input: prompt, voice: 'alloy', response_format: 'mp3' };
  else if (model.kind === 'audio') base = { messages: [{ role: 'user', content: prompt }], modalities: ['text', 'audio'], audio: { voice: 'alloy', format: 'pcm16' }, stream: true };
  else if (model.kind === 'transcription') base = { input_audio: { data: '', format: 'mp3' } };
  else if (model.kind === 'embeddings') base = { input: prompt };
  else if (model.kind === 'rerank') base = { query: prompt, documents: [] };
  else if (model.kind === 'decisions') base = { questions: [prompt] };
  else base = { messages: [{ role: 'user', content: prompt }] };
  const payload = { ...base, ...extras as Record<string, unknown> };
  if (model.kind === 'transcription' && routerAiAudioFile.value) {
    const file = routerAiAudioFile.value;
    const saved = await uploadSource(file, { projectId: studio.activeProjectId, chatId: studio.activeChatId === 'system:recent' ? null : studio.activeChatId });
    payload.input_audio = { data: saved.ref, format: file.name.split('.').pop()?.toLowerCase() || 'mp3' };
  }
  return payload;
}
watch(() => studio.providerDiagnosticRequest, (request, previous) => { if (studio.isAdmin && request > previous) void openDiagnostics(); });

function stopQuoteTimer() {
  if (quoteTimer === null) return;
  clearTimeout(quoteTimer);
  quoteTimer = null;
}

function quoteRequestReady() {
  if (studio.provider === 'codex') return Boolean(studio.codexModel && studio.codexEffort);
  if (studio.provider === 'routerai') return Boolean(studio.routerAiModel);
  return Boolean(studio.mediaModelId && !missingRequiredFields.value.length);
}

async function refreshQuote(revision: number) {
  try {
    if (studio.provider === 'codex') {
      if (!studio.codexModel || !studio.codexEffort) return;
      const result = await getCodexQuote(studio.codexModel, studio.codexEffort, studio.codexSpeed);
      if (revision === quoteRevision) { quote.value = result.quote; quoteError.value = result.error || ''; }
    } else if (studio.provider === 'routerai') {
      let payload: Record<string, unknown> = {};
      if (studio.currentRouterAiModel?.kind === 'video') payload = routerAiVideoPayload(studio.prompt.trim());
      else if (routerAiSpecial.value) {
        const parsed: unknown = JSON.parse(routerAiExtra.value);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(t('routerai.admin.invalidBody'));
        payload = parsed as Record<string, unknown>;
      }
      const result = await getRouterAiQuote(studio.routerAiModel, payload);
      if (revision === quoteRevision) { quote.value = result.quote; quoteError.value = result.error || ''; }
    } else if (studio.mediaModelId) {
      const requestQuote = () => getMediaQuote(studio.mediaModelId, mediaRequestInput(), studio.sourceFiles);
      let result;
      try { result = await requestQuote(); }
      catch (error) {
        if (!retryableReadError(error)) throw error;
        await new Promise(resolve => setTimeout(resolve, 500));
        if (revision !== quoteRevision) return;
        result = await requestQuote();
      }
      if (revision === quoteRevision) quote.value = result;
    }
  } catch (error) {
    if (revision === quoteRevision) { quote.value = null; quoteError.value = error instanceof Error ? error.message : t('composer.priceUnavailable'); }
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

watch(() => [studio.provider, studio.codexModel, studio.routerAiModel, studio.codexEffort, studio.codexSpeed, studio.mediaModelId, studio.mediaInput, studio.sourceFiles], () => scheduleQuoteRefresh(), { immediate: true, deep: true });
watch([routerAiExtra, routerAiVideoDuration, routerAiVideoResolution, routerAiVideoAspectRatio], () => { if (studio.provider === 'routerai') scheduleQuoteRefresh(QUOTE_DEBOUNCE_MS); });
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
      ? t('composer.drop.waitChat')
      : uploading.value
        ? t('composer.drop.waitUpload')
        : t('composer.drop.modelUnsupported');
    return;
  }
  if (dropFields.value.length > 1) {
    submitError.value = t('composer.drop.targetRequired');
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
    if (maxFiles && fieldFiles + files.length > maxFiles) throw new Error(t('composer.files.max', { count: maxFiles }));
    const accept = dropAccept(field);
    const invalid = files.find(file => !matchesAccept(file, accept));
    if (invalid) throw new Error(t('composer.files.unsupportedFormat', { name: invalid.name }));
    const added = [];
    for (const file of files) {
      const maxSizeMb = field?.maxSizeMb || (field ? undefined : 30);
      if (maxSizeMb && file.size > maxSizeMb * 1024 * 1024) throw new Error(t('composer.files.sizeLimit', { name: file.name, size: maxSizeMb }));
      const durationSeconds = await checkedSourceDuration(file, field);
      const saved = await uploadSource(file, { projectId: studio.activeProjectId, chatId: studio.activeChatId === 'system:recent' ? null : studio.activeChatId });
      const item = { ...saved, ref: saved.ref, name: file.name, type: file.type, fieldKey: field?.key, ...(durationSeconds === null ? {} : { durationSeconds }) };
      studio.sourceFiles.push(item); added.push(item.ref);
    }
    if (field) updateField(field.key, field.scalar || field.maxFiles === 1 ? added.at(-1) : [...(Array.isArray(studio.mediaInput[field.key]) ? studio.mediaInput[field.key] as string[] : []), ...added]);
  } catch (error) { submitError.value = error instanceof Error ? error.message : t('composer.files.uploadError'); }
  finally { uploading.value = false; }
}
function sourceDuration(source: File | string, kind: 'audio' | 'video') {
  return new Promise<number>((resolve, reject) => {
    const media = document.createElement(kind);
    const objectUrl = source instanceof File ? URL.createObjectURL(source) : '';
    let settled = false;
    let timer = 0;
    const finish = (error?: Error, duration = media.duration) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      media.removeAttribute('src'); media.load();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (error) reject(error); else resolve(duration);
    };
    timer = window.setTimeout(() => finish(new Error(t('composer.files.durationCheckError'))), 8000);
    media.preload = 'metadata';
    media.onloadedmetadata = () => Number.isFinite(media.duration) && media.duration > 0 ? finish(undefined, media.duration) : finish(new Error(t('composer.files.durationReadError')));
    media.onerror = () => finish(new Error(t('composer.files.mediaReadError')));
    media.src = source instanceof File ? objectUrl : source;
  });
}
function sourceDurationError(name: string, duration: number, range: { min: number; max: number }) {
  const value = formatNumber(duration, { maximumFractionDigits: 1 });
  return t('composer.files.durationRange', { name, duration: value, min: range.min, max: range.max });
}
async function checkedSourceDuration(source: File | string, field?: MediaField, name = source instanceof File ? source.name : t('composer.files.source')) {
  const range = mediaSourceDurationRange(field);
  if (!range) return null;
  const kind = /audio/i.test(field?.accept || field?.key || '') ? 'audio' : 'video';
  const duration = await sourceDuration(source, kind);
  if (duration < range.min || duration > range.max) throw new Error(sourceDurationError(name, duration, range));
  return duration;
}
async function validateSavedSourceDurations() {
  for (const item of studio.sourceFiles) {
    const field = fileFields.value.find(candidate => candidate.key === item.fieldKey);
    const range = mediaSourceDurationRange(field);
    if (!range) continue;
    let duration = Number(item.durationSeconds);
    if (!Number.isFinite(duration) || duration <= 0) {
      const url = sourcePreviewUrl(item.ref);
      if (!url) continue;
      duration = await checkedSourceDuration(url, field, item.name || t('composer.files.source')) || 0;
      item.durationSeconds = duration;
    }
    if (duration < range.min || duration > range.max) throw new Error(sourceDurationError(item.name || t('composer.files.source'), duration, range));
  }
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
  if (unavailableMediaPrice.value) { submitError.value = quoteErrorMessage.value; return; }
  if (hasFieldErrors.value) {
    const [key, message] = Object.entries(allFieldErrors.value)[0] || [];
    const field = currentFields.value.find(item => item.key === key);
    submitError.value = field && message ? `${field.label || field.key}: ${message}` : t('composer.fixParameters');
    return;
  }
  if (missingRequiredFields.value.length) { submitError.value = t('composer.completeRequired'); return; }
  if (studio.provider !== 'media' && !quote.value) { submitError.value = studio.isAdmin ? (quoteError.value || t('composer.waitQuote')) : publicServiceError(quoteError.value, t('composer.waitQuote')); return; }
  if (!studio.prompt.trim() && !(studio.provider === 'routerai' && studio.currentRouterAiModel?.kind === 'transcription' && routerAiAudioFile.value)) { submitError.value = t('composer.enterPrompt'); return; }
  submitError.value = '';
  uploading.value = true;
  let specialPayload: Record<string, unknown> | undefined;
  try { if (routerAiSpecial.value) specialPayload = await routerAiPayload(studio.prompt.trim()); }
  catch (error) { submitError.value = error instanceof Error ? error.message : t('routerai.admin.invalidBody'); uploading.value = false; return; }
  try { await validateSavedSourceDurations(); }
  catch (error) { submitError.value = error instanceof Error ? error.message : t('composer.checkSources'); return; }
  finally { uploading.value = false; }
  animateToQueue(event);
  try { await studio.submit(specialPayload, studio.provider === 'routerai' ? quote.value?.amountUnits : undefined); }
  catch (error) { const message = error instanceof Error ? error.message : ''; submitError.value = studio.isAdmin ? (message || t('composer.startError')) : publicServiceError(message, t('composer.startError')); }
}
</script>

<template>
  <section class="composer-card">
    <div class="composer-tabs">
      <button v-for="item in modeItems" :key="item.id" type="button" :class="{ active: studio.mode === item.id }" @click="changeMode(item.id)">{{ item.icon }} {{ item.label }}</button>
    </div>
    <div class="composer-body">
      <p v-if="studio.provider === 'media' && studio.mode === 'audio' && !modelOptions.length" class="notice" role="status">{{ t('composer.audioUnavailable') }}</p>
      <textarea v-if="showsPrompt" v-model="promptValue" maxlength="20000" :placeholder="promptPlaceholder" :aria-label="t('composer.promptAria')" @keydown.ctrl.enter="submit"></textarea>
      <div v-if="hasSourcePicker || studio.sourceFiles.length || uploading" class="source-strip">
        <label v-if="studio.provider === 'codex' && codexAcceptsImages" class="attach-button">＋ {{ t('composer.sources') }}<input type="file" accept="image/png,image/jpeg,image/webp" multiple @change="addFiles($event)" /></label>
        <label v-for="field in fileFields" v-else :key="field.key" class="attach-button">＋ {{ sourceButtonLabel(field) }}{{ field.required ? ' *' : '' }}<input type="file" :accept="field.accept" :multiple="!field.scalar && field.maxFiles !== 1" @change="addFiles($event, field)" /></label>
        <span v-if="uploading" class="uploading">{{ t('composer.uploading') }}</span>
        <article v-for="(file, index) in studio.sourceFiles" :key="file.ref + index" class="source-preview">
          <img v-if="isImageSource(file.type)" :src="sourcePreviewUrl(file.ref)" :alt="t('composer.thumbnail', { name: file.name })" loading="lazy">
          <span v-else class="source-file-icon" aria-hidden="true">▧</span>
          <button type="button" class="source-remove" :aria-label="t('composer.removeFile', { name: file.name })" @click="removeFile(index)">×</button>
        </article>
      </div>
      <div class="composer-controls">
        <PresetBar />
        <ModelCatalogPicker v-model="modelChoice" :models="modelOptions" :price="selectedModelPrice" />
        <template v-if="studio.provider === 'codex'">
          <label class="select-pill"><span>{{ t('composer.reasoning') }}</span><select v-model="studio.codexEffort"><option v-for="effort in effortOptions" :key="effort" :value="effort">{{ effort }}</option></select></label>
          <AspectRatioPicker v-if="studio.mode === 'image'" v-model="studio.codexAspectRatio" :label="t('composer.format')" :options="['auto', '1:1', '16:9', '9:16', '3:2', '2:3']" />
          <label class="select-pill"><span>{{ t('composer.speed') }}</span><select v-model="studio.codexSpeed"><option value="standard">{{ t('generation.speed.standard') }}</option><option value="fast">⚡ Fast</option></select></label>
        </template>
        <template v-for="field in primaryFields" v-else-if="studio.provider === 'media'" :key="field.key">
          <AspectRatioPicker v-if="isAspectRatioField(field.key)" :model-value="String(fieldValue(field))" :label="field.label || t('composer.format')" :options="fieldOptions(field)" @update:model-value="updateSelectValue(field, $event)" />
          <label v-else class="select-pill"><span>{{ field.label || field.key }}{{ field.required ? ' *' : '' }}</span><select :value="fieldValue(field)" @change="updateSelect(field, $event)"><option v-for="option in fieldOptions(field)" :key="String(option)" :value="String(option)">{{ fieldOptionLabel(field, option) }}</option></select></label>
        </template>
        <span v-if="quoteError" class="quote-error-wrap"><span class="quote error">{{ quoteErrorMessage }}</span><button v-if="studio.isAdmin" type="button" class="details-button" @click="openDiagnostics">{{ t('composer.details') }}</button></span>
        <button class="generate-button" :class="{ 'is-loading': quoteLoading }" type="button" :aria-busy="quoteLoading" :disabled="quoteLoading || uploading || !modelOptions.length || unavailableMediaPrice || (studio.provider !== 'media' && total === null) || hasFieldErrors || missingRequiredFields.length > 0" @click="submit"><span v-if="quoteLoading" class="generate-spinner" aria-hidden="true"></span>{{ quoteLoading ? t('composer.calculating') : t('composer.generate') }}<span v-if="!quoteLoading && total !== null"> · {{ formatNumber(total) }}</span> <span v-if="!quoteLoading" aria-hidden="true">↗</span></button>
      </div>
      <details v-if="studio.provider === 'media' && extraFields.length" class="advanced-settings"><summary>{{ t('composer.advanced') }}</summary><div class="advanced-grid"><label v-for="field in extraFields" :key="field.key" :class="{ invalid: fieldError(field) }"><span>{{ field.label || field.key }}{{ field.required ? ' *' : '' }}</span><select v-if="fieldOptions(field).length" :value="fieldValue(field)" @change="updateSelect(field, $event)"><option v-for="option in fieldOptions(field)" :key="String(option)" :value="String(option)">{{ fieldOptionLabel(field, option) }}</option></select><input v-else-if="field.type === 'number'" type="number" :min="field.min" :max="field.max" :step="field.step" :value="fieldValue(field)" @input="updateTypedField(field, ($event.target as HTMLInputElement).value)" /><input v-else-if="field.type === 'boolean'" type="checkbox" :checked="Boolean(fieldValue(field))" @change="updateTypedField(field, ($event.target as HTMLInputElement).checked)" /><textarea v-else-if="field.type === 'textarea' || field.type === 'json'" :maxlength="field.maxLength" :value="String(fieldValue(field))" @change="updateTypedField(field, ($event.target as HTMLTextAreaElement).value)"></textarea><input v-else type="text" :maxlength="field.maxLength" :value="String(fieldValue(field))" @input="updateTypedField(field, ($event.target as HTMLInputElement).value)" /><small v-if="fieldError(field)" class="field-error">{{ fieldError(field) }}</small><small v-else-if="field.hint">{{ field.hint }}</small></label></div></details>
      <details v-if="routerAiSpecial" class="advanced-settings"><summary>{{ t('composer.advanced') }}</summary><div class="advanced-grid">
        <p>{{ studio.currentRouterAiModel?.id }} · POST /{{ studio.currentRouterAiModel?.endpoint }}</p>
        <label v-if="studio.currentRouterAiModel?.kind === 'transcription'"><span>{{ t('routerai.admin.audioFile') }}</span><input type="file" accept="audio/*" @change="routerAiAudioFile = ($event.target as HTMLInputElement).files?.[0] || null"></label>
        <template v-if="studio.currentRouterAiModel?.kind === 'video'">
          <label v-if="studio.currentRouterAiModel.supportedDurations?.length"><span>{{ t('routerai.admin.duration') }}</span><select v-model.number="routerAiVideoDuration"><option v-for="duration in studio.currentRouterAiModel.supportedDurations" :key="duration" :value="duration">{{ duration }} {{ t('routerai.admin.seconds') }}</option></select></label>
          <label v-if="studio.currentRouterAiModel.supportedResolutions?.length"><span>{{ t('routerai.admin.resolution') }}</span><select v-model="routerAiVideoResolution"><option v-for="resolution in studio.currentRouterAiModel.supportedResolutions" :key="resolution" :value="resolution">{{ resolution }}</option></select></label>
          <label v-if="studio.currentRouterAiModel.supportedAspectRatios?.length"><span>{{ t('routerai.admin.aspectRatio') }}</span><select v-model="routerAiVideoAspectRatio"><option v-for="ratio in studio.currentRouterAiModel.supportedAspectRatios" :key="ratio" :value="ratio">{{ ratio }}</option></select></label>
        </template>
        <template v-else><label><span>{{ t('routerai.admin.body') }}</span><textarea v-model="routerAiExtra" rows="6" spellcheck="false"></textarea></label><small>{{ t('routerai.admin.parametersHint') }}</small></template>
      </div></details>
      <p v-if="missingRequiredFields.length" class="form-error">{{ t('composer.required', { fields: missingRequiredFields.map(field => field.label || field.key).join(', ') }) }}</p>
      <p v-if="submitError" class="form-error" role="alert">{{ submitError }}</p>
      <p class="composer-hint">{{ t('composer.hint') }}</p>
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
              <small>{{ field.scalar || field.maxFiles === 1 ? t('composer.oneFile') : field.maxFiles ? t('composer.upToFiles', { count: field.maxFiles }) : t('composer.multipleFiles') }}</small>
            </article>
          </div>
        </section>
      </div>
      <div v-if="studio.isAdmin && diagnosticOpen" class="diagnostic-backdrop" @click.self="diagnosticOpen = false">
        <section class="diagnostic-dialog" role="dialog" aria-modal="true" :aria-label="t('composer.diagnostics')">
          <header><div><span class="eyebrow">{{ t('composer.diagnosticsEyebrow') }}</span><h2>{{ diagnostics?.provider || 'Kie.ai' }}</h2></div><button type="button" class="dialog-close" :aria-label="t('common.close')" @click="diagnosticOpen = false">×</button></header>
          <div v-if="diagnosticLoading" class="diagnostic-loading">{{ t('composer.diagnosticsChecking') }}</div>
          <div v-else-if="diagnosticError" class="diagnostic-summary error"><strong>{{ t('composer.diagnosticsUnavailable') }}</strong><span>{{ diagnosticError }}</span></div>
          <template v-else-if="diagnostics">
            <div class="diagnostic-summary" :class="diagnostics.ok ? 'success' : 'error'">
              <strong>{{ diagnostics.ok ? t('composer.diagnosticsOk') : t('composer.diagnosticsError') }}</strong>
              <span>{{ diagnostics.model.name || diagnostics.model.id }}<template v-if="diagnostics.quote?.credits != null"> · {{ t('common.credits', { count: diagnostics.quote.credits }) }}</template></span>
            </div>
            <div class="diagnostic-checks">
              <article v-for="item in diagnostics.checks" :key="item.time + item.step" :class="item.status">
                <span class="diagnostic-mark">{{ item.status === 'ok' ? '✓' : '!' }}</span>
                <div><strong>{{ diagnosticStepLabel(item.step) }}</strong><p>{{ item.message }}</p></div>
                <time>{{ t('common.milliseconds', { count: item.durationMs }) }}</time>
              </article>
            </div>
            <details class="diagnostic-mechanism" open><summary>{{ t('composer.requestMechanism') }}</summary><dl><template v-for="(value, key) in diagnostics.mechanism" :key="key"><dt>{{ diagnosticMechanismLabel(key) }}</dt><dd>{{ value }}</dd></template></dl></details>
            <details class="diagnostic-log" open><summary>{{ t('composer.recentLogs') }}</summary><ol><li v-for="(item, index) in diagnostics.recentLogs" :key="item.time + item.step + index" :class="item.status"><time>{{ diagnosticTime(item.time) }}</time><strong>{{ diagnosticStepLabel(item.step) }}</strong><span>{{ item.message }}</span><em>{{ t('common.milliseconds', { count: item.durationMs }) }}</em></li></ol></details>
          </template>
          <footer><button type="button" class="secondary-button" :disabled="diagnosticLoading" @click="openDiagnostics">{{ t('composer.retryCheck') }}</button><button type="button" class="primary-button" @click="diagnosticOpen = false">{{ t('common.close') }}</button></footer>
        </section>
      </div>
    </Teleport>
  </section>
</template>
