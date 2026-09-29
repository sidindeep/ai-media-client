<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useStudioStore } from '../stores/studio';
import { diagnoseProvider, getApimartQuote, getAutoRouteQuote, getCodexQuote, getMediaQuote, getRouterAiQuote } from '../api/client';
import type { AutoRouteQuote, ProviderDiagnostics } from '../api/client';
import type { MediaField } from '../types';
import ModelCatalogPicker from './ModelCatalogPicker.vue';
import AspectRatioPicker from './AspectRatioPicker.vue';
import PresetBar from './PresetBar.vue';
import AdvancedParameters from './AdvancedParameters.vue';
import SchemaField from './SchemaField.vue';
import SourceAttachments from './SourceAttachments.vue';
import { mediaAdvancedParameters, routerAiAdvancedParameters } from '../domain/advanced-parameters';
import { formatMediaFieldValue, mediaFieldOptions, mediaFieldValueError, minimumPricingFieldValue, parseMediaFieldValue } from '../domain/media-fields';
import { apimartModelBrandId, mediaModelBrandId, routerAiModelBrandId } from '../domain/model-catalog';
import { autoModelOptions } from '../domain/auto-models';
import { publicServiceError } from '../domain/result-presentation';
import { aspectRatioName, isAspectRatioField } from '../domain/aspect-ratios';
import { unionFields, unionVariants } from '../domain/union-model-fields';
import { isReferenceField } from '../domain/source-attachments';
import { formatCreditCost, roundedCreditCost } from '../domain/credits';
import { useI18n } from '../i18n';
import { useLatestQuote } from '../composables/useLatestQuote';

const studio = useStudioStore();
const { formatDate, formatNumber, t } = useI18n();
const modeItems = computed(() => [
  { id: 'text', label: t('composer.mode.text'), icon: '▢' },
  { id: 'image', label: t('composer.mode.image'), icon: '▧' },
  ...(studio.fullModelAccess ? [{ id: 'video', label: t('composer.mode.video'), icon: '▹' }, { id: 'audio', label: t('composer.mode.audio'), icon: '⌁' }] : []),
] as Array<{ id: 'text' | 'image' | 'video' | 'audio'; label: string; icon: string }>);
const uploading = ref(false);
const sourceAttachments = ref<InstanceType<typeof SourceAttachments> | null>(null);
const submitting = ref(false);
const submitError = ref('');
const autoRouting = computed(() => studio.autoRouting);
const autoEligible = computed(() => studio.isAdmin && ['media', 'apimart'].includes(studio.provider)
  && (studio.provider !== 'media' || studio.kieAccountId === 'primary') && modelOptions.value.length > 0);
type ComposerQuote = { credits: number | null; amountUnits?: number | null; amountUsd?: number; nativeCredits?: number;
  estimatedInputTokens?: number; estimatedOutputTokens?: number; inputUsdPerToken?: number; outputUsdPerToken?: number;
  status?: string; reason?: string; warning?: string; selectedProviderId?: string;
  autoOffers?: AutoRouteQuote['offers'] };
const { quote, quoteError, quoteLoading, schedule: scheduleQuoteRefresh,
  acceptIfCurrent: acceptDiagnosticQuote, currentRevision: currentQuoteRevision } = useLatestQuote<ComposerQuote>({
  ready: quoteRequestReady, request: requestQuote, unavailableMessage: () => t('composer.priceUnavailable'),
});
const diagnosticOpen = ref(false);
const autoDetailsOpen = ref(false);
const autoDetailsClose = ref<HTMLButtonElement | null>(null);
const autoDetailsTrigger = ref<HTMLButtonElement | null>(null);
async function openAutoDetails() {
  autoDetailsOpen.value = true;
  await nextTick();
  autoDetailsClose.value?.focus();
}
function closeAutoDetails() {
  autoDetailsOpen.value = false;
  autoDetailsTrigger.value?.focus();
}
watch(() => quote.value?.selectedProviderId, selected => { if (!selected) autoDetailsOpen.value = false; });
const diagnosticLoading = ref(false);
const diagnosticError = ref('');
const diagnostics = ref<ProviderDiagnostics | null>(null);
const fieldErrors = ref<Record<string, string>>({});
const unionMode = ref(0);
const routerAiExtra = ref('{}');
const routerAiVideoDuration = ref<number | null>(null);
const routerAiVideoResolution = ref('');
const routerAiVideoAspectRatio = ref('');
const apimartMedia = computed(() => studio.provider === 'apimart' && studio.mode !== 'text');
const apimartWhisper = computed(() => studio.provider === 'apimart' && studio.apimartModel === 'whisper-1');
const apimartFields = computed(() => studio.provider === 'apimart' ? studio.currentApimartModel?.fields || [] : []);
watch(() => [studio.provider, studio.apimartModel, apimartFields.value] as const, () => {
  if (studio.provider !== 'apimart' || !apimartFields.value.length) return;
  const defaults = Object.fromEntries(apimartFields.value.flatMap(field => {
    if (field.type === 'files' || isReferenceField(field) || studio.mediaInput[field.key] !== undefined) return [];
    const value = minimumPricingFieldValue(field);
    return value === undefined ? [] : [[field.key, value]];
  }));
  if (Object.keys(defaults).length) studio.mediaInput = { ...defaults, ...studio.mediaInput };
}, { immediate: true });
const apimartPrimaryFields = computed(() => apimartFields.value.filter(field =>
  /^(size|aspect_ratio|resolution|quality|mode|version|duration|voice)$/.test(field.key) && field.options?.length).slice(0, 3));
const apimartExtraFields = computed(() => apimartFields.value.filter(field => field.type !== 'files'
  && !apimartPrimaryFields.value.includes(field) && !isReferenceField(field)));
const apimartAdvancedFields = computed(() => mediaAdvancedParameters(apimartExtraFields.value, (_field, option) => String(option)).map(field => {
  if (field.kind === 'boolean') return { ...field, kind: 'select' as const,
    options: [{ value: '', label: t('common.default') }, { value: 'true', label: t('common.yes') }, { value: 'false', label: t('common.no') }] };
  return field.kind === 'select' ? { ...field, options: [{ value: '', label: t('common.default') }, ...(field.options || [])] } : field;
}));
const apimartAdvancedValues = computed(() => Object.fromEntries(apimartExtraFields.value.map(field => [field.key, fieldValue(field)])));
const apimartFallbackFields = computed(() => apimartMedia.value && !apimartFields.value.length
  ? [{ key: 'parameters', label: t('routerai.admin.body'), kind: 'json' as const }] : []);
function updateApimartFallback(_key: string, raw: unknown) {
  try {
    const value: unknown = JSON.parse(String(raw || '{}'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(t('routerai.admin.invalidBody'));
    studio.mediaInput = value as Record<string, unknown>;
    fieldErrors.value = {};
  } catch { fieldErrors.value = { parameters: t('validation.json') }; }
}
function updateApimartParameter(key: string, raw: unknown) {
  const field = apimartFields.value.find(item => item.key === key);
  if (!field) return;
  if (raw === '' || raw == null) {
    updateField(key, undefined);
    const errors = { ...fieldErrors.value }; delete errors[key]; fieldErrors.value = errors;
  }
  else updateTypedField(field, field.type === 'boolean' ? raw === true || raw === 'true' : raw);
}
const routerAiSpecial = computed(() => studio.provider === 'routerai' && studio.isAdmin
  && Boolean(studio.currentRouterAiModel) && !['text', 'image'].includes(studio.currentRouterAiModel!.kind));
const QUOTE_DEBOUNCE_MS = 1500;
const effortOptions = computed(() => studio.currentCodexModel?.efforts || ['low', 'medium', 'high']);
const currentFields = computed(() => studio.provider === 'apimart' ? apimartFields.value
  : studio.provider === 'media' ? unionFields(studio.currentMediaModel, unionMode.value)
    : studio.provider === 'routerai' && studio.currentRouterAiModel?.kind === 'transcription'
      ? [{ key: 'audioFile', label: t('routerai.admin.audioFile'), type: 'files', required: true,
        scalar: true, maxFiles: 1, accept: 'audio/*' }] : []);
const currentUnionVariants = computed(() => unionVariants(studio.currentMediaModel));
const primaryFields = computed(() => currentFields.value.filter(field => /aspect|ratio|format|resolution|quality/i.test(field.key) && (field.options?.length || field.schema?.enum?.length)).slice(0, 2));
const taskReferenceField = computed(() => currentFields.value.find(field => field.key === 'task_id' || field.key === 'taskId'));
function compatibleTaskReference(modelId: string, source: { modelId?: string; kind?: string }): boolean {
  if (modelId === 'kie:grok-imagine-image-2-0/segment-edit')
    return ['kie:grok-imagine-image-2-0/text-to-image', 'kie:grok-imagine-image-2-0/segment-map'].includes(source.modelId || '');
  if (modelId === 'kie:grok-imagine/image-to-video') return source.modelId === 'kie:grok-imagine/text-to-image';
  if (['kie:grok-imagine/extend', 'kie:grok-imagine/upscale'].includes(modelId))
    return source.kind === 'video' && Boolean(source.modelId?.startsWith('kie:grok-imagine/'));
  if (modelId === 'kie:ai-music-api/generate-midi-from-audio') return source.modelId === 'kie:ai-music-api/separate-vocals';
  if (modelId.startsWith('kie:ai-music-api/')) return Boolean(source.modelId?.startsWith('kie:ai-music-api/'));
  return false;
}
const taskReferences = computed(() => {
  return studio.history.filter(record => ['media', 'kie'].includes(record.providerId) && record.state === 'success' && record.id
    && (record.kieAccountId || 'primary') === studio.kieAccountId
    && compatibleTaskReference(studio.currentMediaModel?.id || '', record));
});
const extraFields = computed(() => currentFields.value.filter(field => !/prompt/i.test(field.key) && field.type !== 'files'
  && field !== taskReferenceField.value && !primaryFields.value.includes(field)));
const structuredFields = computed(() => extraFields.value.filter(field => field.type === 'json'
  && (field.schema?.type === 'array' || field.schema?.type === 'object')));
const mediaAdvancedFields = computed(() => mediaAdvancedParameters(extraFields.value.filter(field => !structuredFields.value.includes(field)), fieldOptionLabel));
const mediaAdvancedValues = computed(() => Object.fromEntries(extraFields.value.map(field => [field.key, fieldValue(field)])));
const routerAiAdvancedFields = computed(() => routerAiSpecial.value ? routerAiAdvancedParameters(studio.currentRouterAiModel, {
  duration: t('routerai.admin.duration'), seconds: t('routerai.admin.seconds'),
  resolution: t('routerai.admin.resolution'), aspectRatio: t('routerai.admin.aspectRatio'),
  body: t('routerai.admin.body'), parametersHint: t('routerai.admin.parametersHint'),
}) : []);
const routerAiAdvancedValues = computed(() => ({ duration: routerAiVideoDuration.value, resolution: routerAiVideoResolution.value,
  aspect_ratio: routerAiVideoAspectRatio.value, body: routerAiExtra.value }));
const total = computed(() => quote.value?.credits != null
  && (autoRouting.value ? quote.value.selectedProviderId === 'kie' : studio.provider !== 'apimart')
  ? roundedCreditCost(quote.value.credits) : null);
const autoProviderLabel = computed(() => quote.value?.selectedProviderId === 'kie'
  ? studio.catalog?.kieAccounts?.find(account => account.id === 'primary')?.name || 'Kie.ai'
  : quote.value?.selectedProviderId === 'apimart' ? 'APIMart' : quote.value?.selectedProviderId || '');
const autoOfferLabel = (providerId: string) => providerId === 'kie' ? 'Kie.ai · 1'
  : providerId === 'apimart' ? 'APIMart' : providerId;
const apimartPrice = computed(() => (autoRouting.value ? quote.value?.selectedProviderId === 'apimart' : studio.provider === 'apimart')
  && quote.value?.status === 'estimated'
  && quote.value.credits != null && quote.value.amountUsd != null
  ? t('apimart.admin.generationTotal', {
    credits: formatNumber(quote.value.credits, { maximumFractionDigits: 8 }),
    usd: formatNumber(quote.value.amountUsd, { maximumFractionDigits: 8 }),
  }) : '');
const apimartBreakdown = computed(() => studio.provider === 'apimart' && quote.value?.status === 'estimated'
  && quote.value.estimatedInputTokens != null && quote.value.estimatedOutputTokens != null
  && quote.value.inputUsdPerToken != null && quote.value.outputUsdPerToken != null
  && quote.value.amountUsd != null ? t('apimart.admin.priceBreakdown', {
    inputTokens: formatNumber(quote.value.estimatedInputTokens),
    outputTokens: formatNumber(quote.value.estimatedOutputTokens),
    inputRate: formatNumber(quote.value.inputUsdPerToken, { maximumFractionDigits: 12 }),
    outputRate: formatNumber(quote.value.outputUsdPerToken, { maximumFractionDigits: 12 }),
    totalUsd: formatNumber(quote.value.amountUsd, { maximumFractionDigits: 8 }),
  }) : '');
const quoteWarning = computed(() => quote.value?.status === 'unavailable'
  ? studio.provider === 'apimart' ? t('apimart.admin.priceUnavailable')
    : t(studio.mediaModelId === 'kie:kling-2.6/motion-control' ? 'composer.motionControlPriceWarning'
    : quote.value.reason === 'tariff_not_found' ? 'composer.priceTariffMissing'
      : quote.value.reason === 'unsupported_tariff_unit' ? 'composer.priceUnitUnsupported'
        : quote.value.reason === 'tariff_variant_unknown' ? 'composer.priceVariantUnknown' : 'composer.priceUnknownWarning')
  : '');
const quoteErrorMessage = computed(() => {
  if (!quoteError.value) return '';
  if (!studio.isAdmin) return publicServiceError(quoteError.value, t('composer.quoteRetry'));
  return studio.provider === 'media' && !autoRouting.value ? t('composer.quoteRetryKie', { error: quoteError.value }) : quoteError.value;
});
const modelChoice = computed({
  get: () => studio.autoRouting && studio.provider === 'apimart' ? `apimart:${studio.apimartModel}`
    : studio.provider === 'codex' ? studio.codexModel : studio.provider === 'routerai' ? studio.routerAiModel
    : studio.provider === 'apimart' ? studio.apimartModel : studio.mediaModelId,
  set: value => {
    if (studio.autoRouting) studio.setAutoModel(value);
    else studio.setSelectedModel(value);
    fieldErrors.value = {};
  },
});
const modelOptions = computed(() => studio.autoRouting
  ? autoModelOptions(studio.catalog?.models || [], studio.apimartCatalog?.models || [], studio.mode)
  : studio.provider === 'apimart'
  ? studio.apimartModels.map(model => ({ value: model.id, label: model.name, description: 'APIMart', groupId: apimartModelBrandId(model.id) }))
  : studio.provider === 'routerai'
  ? studio.routerAiModels.map(model => ({ value: model.id, label: model.name, description: model.description || 'RouterAI', groupId: routerAiModelBrandId(model.id) }))
  : studio.provider === 'codex'
  ? (studio.codexCatalog?.models || []).map(model => ({ value: model.id, label: model.name, description: studio.isAdmin ? t('composer.codexDescriptionAdmin') : t('composer.codexDescription'), groupId: 'codex' }))
  : studio.mediaModels.map(model => ({ value: model.id, label: model.name.trim(), description: model.description, groupId: mediaModelBrandId(model.id, model.name) })));
const autoModelName = computed(() => modelOptions.value.find(model => model.value === modelChoice.value)?.label || modelChoice.value);
const promptField = computed(() => studio.provider === 'media' ? currentFields.value.find(field => field.key === 'prompt' || field.key === 'text') : undefined);
const showsPrompt = computed(() => !apimartWhisper.value && (studio.provider !== 'media' || Boolean(promptField.value)));
const promptValue = computed({
  get: () => studio.prompt,
  set: value => { studio.prompt = value; },
});
const promptPlaceholder = computed(() => studio.mode === 'audio'
  ? promptField.value?.key === 'text' ? t('composer.promptVoice') : t('composer.promptAudio')
  : t('composer.promptDefault'));
const selectedModelPrice = computed(() => !autoRouting.value && studio.provider !== 'apimart' && quote.value?.credits != null
  ? `${formatCreditCost(quote.value.credits)} ${t('common.creditsShort')}` : undefined);
const valueErrors = computed(() => Object.fromEntries(currentFields.value.flatMap(field => {
  if (field.type === 'files' || /prompt/i.test(field.key)) return [];
  const message = mediaFieldValueError(field, studio.mediaInput[field.key] ?? field.default);
  return message ? [[field.key, message]] : [];
})));
const allFieldErrors = computed(() => ({ ...valueErrors.value, ...fieldErrors.value }));
const hasFieldErrors = computed(() => Object.keys(allFieldErrors.value).length > 0);
const missingRequiredFields = computed(() => ['media', 'apimart', 'routerai'].includes(studio.provider) ? currentFields.value.filter(field => {
  if (!field.required) return false;
  if (field.key === 'prompt' || field.key === 'text') return !studio.prompt.trim();
  const value = studio.mediaInput[field.key];
  return value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length);
}) : []);
const mediaRequestInput = () => ({ ...studio.mediaInput, ...(promptField.value ? { [promptField.value.key]: studio.prompt } : {}) });
const retryableReadError = (error: unknown) => error instanceof Error
  && /^(?:Не удалось выполнить запрос|Некорректный ответ сервиса|Подключаемся к базе данных|Связь с базой данных временно недоступна)/i.test(error.message);

function fieldOptions(field: MediaField) { return mediaFieldOptions(field); }
function fieldOptionLabel(field: MediaField, option: unknown) {
  if (field.key === 'duration' && Number(option) <= 0) return t('composer.auto');
  const name = isAspectRatioField(field.key) ? aspectRatioName(option) : '';
  return name ? `${option} — ${name}` : String(option);
}
function updateField(key: string, value: unknown) {
  const input = { ...studio.mediaInput };
  if (value === undefined) delete input[key]; else input[key] = value;
  studio.mediaInput = input;
}
function fieldValue(field: MediaField) { return formatMediaFieldValue(field, studio.mediaInput[field.key] ?? field.default); }
function updateTypedField(field: MediaField, raw: unknown) {
  try {
    const parsed = parseMediaFieldValue(field, raw);
    updateField(field.key, parsed);
    if (field.type === 'json') {
      const refs = new Set<string>();
      const visit = (value: unknown) => {
        if (typeof value === 'string') refs.add(value);
        else if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object') Object.values(value).forEach(visit);
      };
      visit(parsed);
      studio.sourceFiles = studio.sourceFiles.filter(file => file.fieldKey !== field.key || refs.has(file.ref));
    }
    const errors = { ...fieldErrors.value }; delete errors[field.key]; fieldErrors.value = errors;
  } catch (error) {
    fieldErrors.value = { ...fieldErrors.value, [field.key]: error instanceof Error ? error.message : t('composer.invalidValue') };
  }
}
function registerStructuredUpload(file: { ref: string; name: string; type: string; fieldKey: string }) {
  studio.sourceFiles.push(file);
}
function updateSelect(field: MediaField, event: Event) {
  updateSelectValue(field, (event.target as HTMLSelectElement).value);
}
function updateSelectValue(field: MediaField, raw: string) {
  const option = fieldOptions(field).find(value => String(value) === raw);
  updateTypedField(field, option === undefined ? raw : option);
}
function updateMediaAdvanced(key: string, raw: unknown) {
  const field = extraFields.value.find(item => item.key === key);
  if (!field) return;
  if (fieldOptions(field).length) updateSelectValue(field, String(raw));
  else updateTypedField(field, raw);
}
function updateRouterAiAdvanced(key: string, raw: unknown) {
  if (key === 'duration') routerAiVideoDuration.value = Number(raw);
  else if (key === 'resolution') routerAiVideoResolution.value = String(raw);
  else if (key === 'aspect_ratio') routerAiVideoAspectRatio.value = String(raw);
  else if (key === 'body') routerAiExtra.value = String(raw);
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
  const revision = currentQuoteRevision();
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
    if (result.ok && result.quote?.credits != null && studio.provider === 'media' && studio.mediaModelId === modelId) {
      acceptDiagnosticQuote(revision, { credits: Number(result.quote.credits) });
    }
  } catch (error) {
    diagnosticError.value = error instanceof Error ? error.message : t('composer.diagnosticLoadError');
  } finally { diagnosticLoading.value = false; }
}

function normalizeCurrentFields() {
  const allowed = new Set(currentFields.value.map(field => field.key));
  const defaults = Object.fromEntries(currentFields.value.flatMap(field => {
    const minimum = minimumPricingFieldValue(field);
    if (minimum !== undefined) return [[field.key, minimum]];
    if (field.required && field.type === 'boolean') return [[field.key, false]];
    const firstOption = fieldOptions(field)[0];
    return firstOption === undefined ? [] : [[field.key, parseMediaFieldValue(field, firstOption)]];
  }));
  const current = Object.fromEntries(Object.entries(studio.mediaInput).filter(([key]) => allowed.has(key)));
  studio.mediaInput = { ...defaults, ...current };
  fieldErrors.value = Object.fromEntries(Object.entries(fieldErrors.value).filter(([key]) => allowed.has(key)));
}
watch(() => studio.currentMediaModel?.id, () => {
  unionMode.value = 0;
  normalizeCurrentFields();
}, { immediate: true });
function selectUnionMode(event: Event) {
  unionMode.value = Number((event.target as HTMLSelectElement).value);
  studio.sourceFiles = [];
  studio.mediaInput = {};
  fieldErrors.value = {};
  normalizeCurrentFields();
}
watch(() => [studio.mode, studio.provider], () => { submitError.value = ''; fieldErrors.value = {}; });
watch(() => studio.currentRouterAiModel?.id, () => {
  routerAiExtra.value = '{}';
  const model = studio.currentRouterAiModel;
  routerAiVideoDuration.value = model?.supportedDurations?.length
    ? Math.min(...model.supportedDurations) : null;
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
  if (model.kind === 'transcription') {
    const file = studio.sourceFiles.find(item => item.fieldKey === 'audioFile');
    if (!file) throw new Error(t('composer.completeRequired'));
    payload.input_audio = { data: file.ref, format: file.name.split('.').pop()?.toLowerCase() || 'mp3' };
  }
  return payload;
}
watch(() => studio.providerDiagnosticRequest, (request, previous) => { if (studio.isAdmin && request > previous) void openDiagnostics(); });

function quoteRequestReady() {
  if (studio.provider === 'apimart') return Boolean(studio.apimartModel && (!studio.currentApimartModel?.promptRequired || studio.prompt.trim()));
  if (studio.provider === 'codex') return Boolean(studio.codexModel && studio.codexEffort);
  if (studio.provider === 'routerai') return Boolean(studio.routerAiModel);
  return Boolean(studio.mediaModelId && !missingRequiredFields.value.length);
}

async function requestQuote(revision: number, isCurrent: (revision: number) => boolean): Promise<{ quote: ComposerQuote | null; error?: string }> {
  if (autoRouting.value && autoEligible.value) {
    const result = await getAutoRouteQuote({ modelId: modelChoice.value,
      input: studio.provider === 'apimart' ? { prompt: studio.prompt.trim(),
        ...(studio.mode === 'text' ? {} : studio.mediaInput) } : mediaRequestInput(),
      sourceFiles: studio.provider === 'media' ? studio.sourceFiles : [] });
    return { quote: { credits: result.selected.credits ?? null,
      nativeCredits: result.selected.nativeCredits, amountUsd: result.selected.costUsd,
      selectedProviderId: result.selected.providerId, autoOffers: result.offers, status: 'estimated' } };
  }
  if (studio.provider === 'apimart') {
    return { quote: await getApimartQuote(studio.apimartModel, studio.prompt.trim(),
      studio.mode === 'text' ? {} : studio.mediaInput) };
  }
  if (studio.provider === 'codex') {
    const result = await getCodexQuote(studio.codexModel, studio.codexEffort, studio.codexSpeed);
    return { quote: result.quote, error: result.error };
  }
  if (studio.provider === 'routerai') {
    let payload: Record<string, unknown> = {};
    if (studio.currentRouterAiModel?.kind === 'video') payload = routerAiVideoPayload(studio.prompt.trim());
    else if (routerAiSpecial.value) {
      const parsed: unknown = JSON.parse(routerAiExtra.value);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(t('routerai.admin.invalidBody'));
      payload = parsed as Record<string, unknown>;
    }
    const result = await getRouterAiQuote(studio.routerAiModel, payload);
    return { quote: result.quote, error: result.error };
  }
  const send = () => getMediaQuote(studio.mediaModelId, mediaRequestInput(), studio.sourceFiles);
  try { return { quote: await send() }; }
  catch (error) {
    if (!retryableReadError(error)) throw error;
    await new Promise(resolve => setTimeout(resolve, 500));
    return { quote: isCurrent(revision) ? await send() : null };
  }
}

watch(() => [studio.provider, studio.apimartModel, studio.codexModel, studio.routerAiModel, studio.codexEffort, studio.codexSpeed, studio.mediaModelId, studio.mediaInput, studio.sourceFiles, autoRouting.value], () => scheduleQuoteRefresh(), { immediate: true, deep: true });
watch([routerAiExtra, routerAiVideoDuration, routerAiVideoResolution, routerAiVideoAspectRatio], () => { if (studio.provider === 'routerai') scheduleQuoteRefresh(QUOTE_DEBOUNCE_MS); });
watch(() => studio.prompt, () => {
  if (studio.provider === 'media' || studio.provider === 'apimart') scheduleQuoteRefresh(QUOTE_DEBOUNCE_MS);
});
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
function submissionSelection() {
  return JSON.stringify([studio.provider, studio.kieAccountId, studio.mode, studio.mediaModelId, autoRouting.value,
    studio.codexModel, studio.routerAiModel, studio.apimartModel, unionMode.value, studio.prompt, studio.sourceFiles.map(item => item.ref)]);
}

async function submit(event?: Event) {
  if (submitting.value || uploading.value) return;
  if (hasFieldErrors.value) {
    const [key, message] = Object.entries(allFieldErrors.value)[0] || [];
    const field = currentFields.value.find(item => item.key === key);
    submitError.value = field && message ? `${field.label || field.key}: ${message}` : t('composer.fixParameters');
    return;
  }
  if (missingRequiredFields.value.length) { submitError.value = t('composer.completeRequired'); return; }
  if (autoRouting.value && !autoEligible.value) { submitError.value = t('composer.autoUnsupported'); return; }
  if (autoRouting.value && !quote.value?.selectedProviderId) { submitError.value = quoteError.value || t('composer.waitQuote'); return; }
  if (studio.provider === 'apimart' && !autoRouting.value && quote.value?.status !== 'estimated') {
    submitError.value = quoteError.value || t('apimart.admin.priceUnavailable'); return;
  }
  if (studio.provider === 'codex' && !quote.value) { submitError.value = studio.isAdmin ? (quoteError.value || t('composer.waitQuote')) : publicServiceError(quoteError.value, t('composer.waitQuote')); return; }
  if (studio.provider === 'routerai' && !quote.value) { submitError.value = quoteError.value || t('composer.waitQuote'); return; }
  if ((studio.provider === 'codex' || studio.provider === 'apimart' && studio.currentApimartModel?.promptRequired || studio.provider === 'routerai' && studio.currentRouterAiModel?.kind !== 'transcription') && !studio.prompt.trim()) { submitError.value = t('composer.enterPrompt'); return; }
  const selectedAtClick = submissionSelection();
  submitError.value = '';
  submitting.value = true;
  try {
    uploading.value = true;
    let specialPayload: Record<string, unknown> | undefined;
    try { if (routerAiSpecial.value) specialPayload = await routerAiPayload(studio.prompt.trim()); }
    catch (error) { submitError.value = error instanceof Error ? error.message : t('routerai.admin.invalidBody'); return; }
    try { await sourceAttachments.value?.validateSavedSourceDurations(); }
    catch (error) { submitError.value = error instanceof Error ? error.message : t('composer.checkSources'); return; }
    finally { uploading.value = false; }
    if (submissionSelection() !== selectedAtClick) { submitError.value = t('composer.selectionChanged'); return; }
    animateToQueue(event);
    try { await studio.submit(specialPayload, studio.provider === 'routerai' ? quote.value?.amountUnits ?? undefined : undefined, autoRouting.value); }
    catch (error) { const message = error instanceof Error ? error.message : ''; submitError.value = studio.isAdmin ? (message || t('composer.startError')) : publicServiceError(message, t('composer.startError')); }
  } finally { uploading.value = false; submitting.value = false; }
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
      <label v-if="studio.provider === 'media' && currentUnionVariants.length" class="select-pill"><span>{{ t('composer.unionMode') }}</span><select :value="unionMode" @change="selectUnionMode"><option v-for="(variant, index) in currentUnionVariants" :key="index" :value="index">{{ variant.title || t('composer.unionVariant', { number: index + 1 }) }}</option></select></label>
      <SourceAttachments ref="sourceAttachments" :fields="currentFields" @error="submitError = $event" @uploading="uploading = $event" />
      <div v-if="studio.provider === 'media' && taskReferenceField" class="task-reference-field">
        <label v-if="taskReferences.length">{{ t('composer.taskReference.choose') }}
          <select :value="studio.mediaInput[taskReferenceField.key] ?? ''" @change="updateField(taskReferenceField.key, ($event.target as HTMLSelectElement).value || undefined)">
            <option value="">{{ t('composer.taskReference.manual') }}</option>
            <option v-for="record in taskReferences" :key="record.id" :value="record.id">{{ record.modelName || record.modelId }} · {{ formatDate(record.createdAt || '') }}</option>
          </select>
        </label>
        <label>{{ taskReferenceField.label || taskReferenceField.key }}{{ taskReferenceField.required ? ' *' : '' }}
          <input type="text" :value="studio.mediaInput[taskReferenceField.key] ?? ''" @input="updateField(taskReferenceField.key, ($event.target as HTMLInputElement).value || undefined)" />
        </label>
        <small>{{ t('composer.taskReference.hint') }}</small>
      </div>
      <div class="composer-controls">
        <PresetBar v-if="studio.provider !== 'apimart'" />
        <ModelCatalogPicker v-model="modelChoice" :models="modelOptions" :price="selectedModelPrice" />
        <template v-if="studio.provider === 'codex'">
          <label class="select-pill"><span>{{ t('composer.reasoning') }}</span><select v-model="studio.codexEffort"><option v-for="effort in effortOptions" :key="effort" :value="effort">{{ effort }}</option></select></label>
          <AspectRatioPicker v-if="studio.mode === 'image'" v-model="studio.codexAspectRatio" :label="t('composer.format')" :options="['auto', '1:1', '16:9', '9:16', '3:2', '2:3']" />
          <label class="select-pill"><span>{{ t('composer.speed') }}</span><select v-model="studio.codexSpeed"><option value="standard">{{ t('generation.speed.standard') }}</option><option value="fast">⚡ Fast</option></select></label>
        </template>
        <label v-for="field in apimartPrimaryFields" :key="`apimart:${field.key}`" class="select-pill"><span>{{ field.label || field.key }}{{ field.required ? ' *' : '' }}</span>
          <select :value="String(studio.mediaInput[field.key] ?? '')" @change="updateApimartParameter(field.key, ($event.target as HTMLSelectElement).value)">
            <option value="">{{ t('common.default') }}</option><option v-for="value in field.options" :key="String(value)" :value="String(value)">{{ value }}</option>
          </select>
        </label>
        <template v-for="field in primaryFields" v-if="studio.provider === 'media'" :key="field.key">
          <AspectRatioPicker v-if="isAspectRatioField(field.key)" :model-value="String(fieldValue(field))" :label="field.label || t('composer.format')" :options="fieldOptions(field)" @update:model-value="updateSelectValue(field, $event)" />
          <label v-else class="select-pill"><span>{{ field.label || field.key }}{{ field.required ? ' *' : '' }}</span><select :value="fieldValue(field)" @change="updateSelect(field, $event)"><option v-for="option in fieldOptions(field)" :key="String(option)" :value="String(option)">{{ fieldOptionLabel(field, option) }}</option></select></label>
        </template>
        <span v-if="quoteWarning" class="quote warning" role="status">{{ quoteWarning }}</span>
        <span v-else-if="quoteError" class="quote-error-wrap"><span class="quote error">{{ quoteErrorMessage }}</span><button v-if="studio.isAdmin" type="button" class="details-button" @click="openDiagnostics">{{ t('composer.details') }}</button></span>
        <button class="generate-button" :class="{ 'is-loading': quoteLoading || submitting }" type="button" :aria-busy="quoteLoading || submitting" :disabled="quoteLoading || uploading || submitting || !modelOptions.length || (autoRouting && (!autoEligible || !quote?.selectedProviderId)) || (studio.provider === 'apimart' && !autoRouting && quote?.status !== 'estimated') || (studio.provider === 'codex' && total === null) || (studio.provider === 'routerai' && !quote) || hasFieldErrors || missingRequiredFields.length > 0" @click="submit"><span v-if="quoteLoading || submitting" class="generate-spinner" aria-hidden="true"></span>{{ quoteLoading ? t('composer.calculating') : submitting ? t('common.loading') : t('composer.generate') }}<span v-if="!quoteLoading && !submitting && total !== null"> · {{ formatNumber(total) }}</span><span v-else-if="!quoteLoading && !submitting && apimartPrice"> · {{ apimartPrice }}</span> <span v-if="!quoteLoading && !submitting" aria-hidden="true">↗</span></button>
      </div>
      <p v-if="studio.provider === 'apimart' && !autoRouting" class="apimart-billing-note" :class="{ 'is-error': studio.apimartCatalog?.error }" :role="studio.apimartCatalog?.error ? 'alert' : undefined">{{ studio.apimartCatalog?.error || apimartBreakdown || t(apimartMedia ? 'apimart.admin.mediaBillingNotice' : 'apimart.admin.billingNotice') }}</p>
      <p v-if="autoRouting" class="auto-route-note" role="status"><template v-if="!autoEligible">{{ t('composer.autoUnsupported') }}</template><template v-else-if="quote?.selectedProviderId"><strong>{{ t('composer.autoSelected', { provider: autoProviderLabel }) }}</strong><button ref="autoDetailsTrigger" type="button" class="auto-route-details-button" @click="openAutoDetails">{{ t('composer.details') }}</button><span> · {{ t('composer.autoEstimate', { usd: formatNumber(quote.amountUsd ?? 0, { maximumFractionDigits: 6 }) }) }}</span></template><template v-else>{{ quoteError || t('composer.calculating') }}</template></p>
      <AdvancedParameters v-if="apimartMedia" :key="`apimart:${studio.apimartModel}`" :fields="apimartAdvancedFields" :values="apimartAdvancedValues" :errors="allFieldErrors" @change="updateApimartParameter" />
      <AdvancedParameters v-if="apimartFallbackFields.length" :fields="apimartFallbackFields" :values="{ parameters: JSON.stringify(studio.mediaInput, null, 2) }" :errors="fieldErrors" @change="updateApimartFallback" />
      <AdvancedParameters v-if="studio.provider === 'media'" :key="`media:${studio.mediaModelId}`" :fields="mediaAdvancedFields" :values="mediaAdvancedValues" :errors="allFieldErrors" @change="updateMediaAdvanced" />
      <div v-if="studio.provider === 'media' && structuredFields.length" class="advanced-settings schema-fields">
        <SchemaField v-for="field in structuredFields" :key="field.key" :schema="field.schema || {}" :model-value="studio.mediaInput[field.key]"
          :name="field.key" :root-key="field.key" :label="field.label || field.key" :required="field.required" :error="allFieldErrors[field.key]"
          @change="updateTypedField(field, $event)" @uploaded="registerStructuredUpload" />
      </div>
      <AdvancedParameters v-if="routerAiSpecial" :key="`routerai:${studio.currentRouterAiModel?.id}`" :fields="routerAiAdvancedFields" :values="routerAiAdvancedValues" :context="`${studio.currentRouterAiModel?.id} · POST /${studio.currentRouterAiModel?.endpoint}`" @change="updateRouterAiAdvanced" />
      <p v-if="missingRequiredFields.length" class="form-error">{{ t('composer.required', { fields: missingRequiredFields.map(field => field.label || field.key).join(', ') }) }}</p>
      <p v-if="submitError" class="form-error" role="alert">{{ submitError }}</p>
      <p class="composer-hint">{{ t('composer.hint') }}</p>
    </div>
    <Teleport to="body">
      <div v-if="autoDetailsOpen && quote?.selectedProviderId" class="auto-route-backdrop" @click.self="closeAutoDetails" @keydown.esc.stop.prevent="closeAutoDetails">
        <section class="auto-route-dialog" role="dialog" aria-modal="true" :aria-label="t('composer.autoRoutesTitle')">
          <header><div><span class="eyebrow">{{ t('composer.autoSelected', { provider: autoProviderLabel }) }}</span><h2>{{ t('composer.autoRoutesTitle') }}</h2><p class="auto-route-dialog-model">{{ t('composer.autoModel') }}: {{ autoModelName }}</p></div><button ref="autoDetailsClose" type="button" class="dialog-close" :aria-label="t('common.close')" @click="closeAutoDetails">×</button></header>
          <p class="auto-route-dialog-intro">{{ t('composer.autoRoutesExplanation') }}</p>
          <div class="auto-route-table-wrap"><table class="auto-route-table"><thead><tr><th scope="col">{{ t('composer.autoRouter') }}</th><th scope="col">{{ t('composer.autoPrice') }}</th><th scope="col">{{ t('composer.autoPurchaseEstimate') }}</th><th scope="col">{{ t('composer.autoStatus') }}</th></tr></thead>
            <tbody><tr v-for="(offer, index) in quote.autoOffers || []" :key="`${offer.providerId}:${index}`" :class="{ selected: offer.providerId === quote.selectedProviderId && !offer.unavailable }"><th scope="row"><strong>{{ autoOfferLabel(offer.providerId) }}</strong><span class="auto-route-model-name">{{ autoModelName }}</span><small v-if="offer.modelId">{{ offer.modelId }}</small></th><td>{{ offer.credits != null ? `${formatCreditCost(offer.credits)} ${t('common.creditsShort')}` : '—' }}</td><td>{{ offer.costUsd != null ? `$${formatNumber(offer.costUsd, { maximumFractionDigits: 6 })}` : '—' }}</td><td>{{ offer.unavailable ? offer.reason || t('composer.autoUnavailable') : offer.providerId === quote.selectedProviderId ? t('composer.autoSelectedStatus') : t('composer.autoAvailableStatus') }}</td></tr></tbody>
          </table></div>
          <p class="auto-route-dialog-note">{{ t('composer.autoRoutesFootnote') }}</p>
        </section>
      </div>
    </Teleport>
    <Teleport to="body">
      <div v-if="studio.isAdmin && diagnosticOpen" class="diagnostic-backdrop" @click.self="diagnosticOpen = false">
        <section class="diagnostic-dialog" role="dialog" aria-modal="true" :aria-label="t('composer.diagnostics')">
          <header><div><span class="eyebrow">{{ t('composer.diagnosticsEyebrow') }}</span><h2>{{ diagnostics?.provider || 'Kie.ai' }}</h2></div><button type="button" class="dialog-close" :aria-label="t('common.close')" @click="diagnosticOpen = false">×</button></header>
          <div v-if="diagnosticLoading" class="diagnostic-loading">{{ t('composer.diagnosticsChecking') }}</div>
          <div v-else-if="diagnosticError" class="diagnostic-summary error"><strong>{{ t('composer.diagnosticsUnavailable') }}</strong><span>{{ diagnosticError }}</span></div>
          <template v-else-if="diagnostics">
            <div class="diagnostic-summary" :class="diagnostics.ok ? 'success' : 'error'">
              <strong>{{ diagnostics.ok ? t('composer.diagnosticsOk') : t('composer.diagnosticsError') }}</strong>
              <span>{{ diagnostics.model.name || diagnostics.model.id }}<template v-if="diagnostics.quote?.credits != null"> · {{ t('common.credits', { count: diagnostics.quote.credits }) }}</template></span>
              <span v-if="diagnostics.balance != null">{{ t('sidebar.remainingCredits', { count: formatNumber(diagnostics.balance) }) }}</span>
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
