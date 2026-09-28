<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref } from 'vue';
import type { MediaField } from '../types';
import { useStudioStore } from '../stores/studio';
import { useI18n } from '../i18n';
import { mediaFileValue, mediaSourceDurationRange } from '../domain/media-fields';
import { frameFieldPair, orderedFileFields } from '../domain/frame-fields';
import { isReferenceField, saveSourceAttachment, sourcePreviewUrl } from '../domain/source-attachments';

const props = defineProps<{ fields: MediaField[] }>();
const emit = defineEmits<{ error: [message: string]; uploading: [active: boolean] }>();
const studio = useStudioStore();
const { formatNumber, t } = useI18n();
const FrameSourcePicker = defineAsyncComponent(() => import('./FrameSourcePicker.vue'));
const uploading = ref(false);
const draggingFiles = ref(false);
const activeDropFieldKey = ref('');
const fileFields = computed(() => orderedFileFields(props.fields.filter(field => field.type === 'files')));
const frameFields = computed(() => frameFieldPair(fileFields.value));
const otherFileFields = computed(() => frameFields.value
  ? fileFields.value.filter(field => !frameFields.value!.includes(field)) : fileFields.value);
const apimartReferenceFields = computed(() => studio.provider === 'apimart'
  ? props.fields.filter(isReferenceField) : []);
const hasSourcePicker = computed(() => studio.provider === 'codex'
  ? studio.currentCodexModel?.inputModalities?.includes('image') === true
  : ['media', 'apimart', 'routerai'].includes(studio.provider) && fileFields.value.length > 0);
const dropFields = computed(() => ['media', 'apimart', 'routerai'].includes(studio.provider) ? fileFields.value : []);
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
function sourceButtonLabel(field: MediaField) {
  return fileFields.value.length === 1 ? t('composer.sources') : field.label || t('composer.sources');
}
function dropFieldLabel(field: MediaField) {
  if (field === frameFields.value?.[0]) return t('composer.frame.first');
  if (field === frameFields.value?.[1]) return t('composer.frame.last');
  return field.label || field.key;
}
function apimartReferences(field: MediaField) {
  const value = studio.mediaInput[field.key];
  return Array.isArray(value) ? value.filter(item => !String(item).startsWith('content:')).join('\n')
    : String(value || '').startsWith('content:') ? '' : String(value || '');
}
function updateApimartReferences(field: MediaField, event: Event) {
  const value = (event.target as HTMLTextAreaElement).value.trim();
  const previous = studio.mediaInput[field.key];
  const uploaded = Array.isArray(previous) ? previous.filter(item => String(item).startsWith('content:')) : [];
  const next = field.schema?.type === 'array' ? [...uploaded, ...value.split(/\r?\n/).filter(Boolean)] : value || undefined;
  const input = { ...studio.mediaInput };
  if (next === undefined || Array.isArray(next) && !next.length) delete input[field.key]; else input[field.key] = next;
  studio.mediaInput = input;
  if (field.schema?.type !== 'array' && value) {
    studio.sourceFiles = studio.sourceFiles.filter(file => file.fieldKey !== field.key);
  }
}
function matchesAccept(file: File, accept?: string) {
  const accepted = String(accept || '').split(',').map(value => value.trim().toLowerCase().replace(/\.+$/, '')).filter(Boolean);
  if (!accepted.length) return true;
  const mime = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  return accepted.some(value => value.startsWith('.') ? name.endsWith(value)
    : value.endsWith('/*') ? mime.startsWith(value.slice(0, -1)) : mime === value);
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
    media.onloadedmetadata = () => Number.isFinite(media.duration) && media.duration > 0
      ? finish(undefined, media.duration) : finish(new Error(t('composer.files.durationReadError')));
    media.onerror = () => finish(new Error(t('composer.files.mediaReadError')));
    media.src = source instanceof File ? objectUrl : source;
  });
}
function sourceDurationError(name: string, duration: number, range: { min: number; max: number }) {
  return t('composer.files.durationRange', { name, duration: formatNumber(duration, { maximumFractionDigits: 1 }),
    min: range.min, max: range.max });
}
async function checkedSourceDuration(source: File | string, field?: MediaField,
  name = source instanceof File ? source.name : t('composer.files.source')) {
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
defineExpose({ validateSavedSourceDurations });

async function uploadFiles(files: File[], field?: MediaField) {
  if (!files.length || uploading.value) return;
  uploading.value = true; emit('uploading', true); emit('error', '');
  try {
    const fieldFiles = studio.sourceFiles.filter(item => item.fieldKey === field?.key).length;
    const maxFiles = field ? (field.scalar ? 1 : field.maxFiles) : 10;
    if (maxFiles && fieldFiles + files.length > maxFiles) throw new Error(t('composer.files.max', { count: maxFiles }));
    const accept = field?.accept || (studio.provider === 'codex' ? 'image/png,image/jpeg,image/webp' : '');
    const invalid = files.find(file => !matchesAccept(file, accept));
    if (invalid) throw new Error(t('composer.files.unsupportedFormat', { name: invalid.name }));
    const added = [];
    for (const file of files) {
      const maxSizeMb = field?.maxSizeMb || (field ? undefined : 30);
      if (maxSizeMb && file.size > maxSizeMb * 1024 * 1024) throw new Error(t('composer.files.sizeLimit', { name: file.name, size: maxSizeMb }));
      const durationSeconds = await checkedSourceDuration(file, field);
      const saved = await saveSourceAttachment(file, studio, field?.key);
      const item = { ...saved, ...(durationSeconds === null ? {} : { durationSeconds }) };
      studio.sourceFiles.push(item); added.push(item.ref);
    }
    if (field) {
      const previous = studio.mediaInput[field.key];
      studio.mediaInput = { ...studio.mediaInput,
        [field.key]: mediaFileValue(field, [...(Array.isArray(previous) ? previous : previous ? [previous] : []), ...added]) };
    }
  } catch (error) { emit('error', error instanceof Error ? error.message : t('composer.files.uploadError')); }
  finally { uploading.value = false; emit('uploading', false); }
}
async function addFiles(event: Event, field?: MediaField) {
  const input = event.target as HTMLInputElement;
  const files = [...(input.files || [])];
  await uploadFiles(files, field);
  input.value = '';
}
function removeFile(index: number) {
  const item = studio.sourceFiles[index]; studio.sourceFiles.splice(index, 1);
  if (!item.fieldKey) return;
  const field = fileFields.value.find(candidate => candidate.key === item.fieldKey);
  if (field) {
    const previous = studio.mediaInput[item.fieldKey];
    const remaining = (Array.isArray(previous) ? previous : previous ? [previous] : [])
      .filter(value => value !== item.ref);
    const value = mediaFileValue(field, remaining);
    const input = { ...studio.mediaInput };
    if (value === undefined) delete input[item.fieldKey]; else input[item.fieldKey] = value;
    studio.mediaInput = input;
  } else {
    const removeRef = (value: unknown): unknown => {
      if (value === item.ref) return undefined;
      if (Array.isArray(value)) return value.map(removeRef).filter(part => part !== undefined);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
        .map(([key, part]) => [key, removeRef(part)]).filter(([, part]) => part !== undefined));
      return value;
    };
    const value = removeRef(studio.mediaInput[item.fieldKey]);
    const input = { ...studio.mediaInput };
    if (value === undefined) delete input[item.fieldKey]; else input[item.fieldKey] = value;
    studio.mediaInput = input;
  }
}
function hasDraggedFiles(event: DragEvent) {
  return Array.from(event.dataTransfer?.types || []).includes('Files');
}
function closeDropOverlay() { draggingFiles.value = false; activeDropFieldKey.value = ''; }
function onWindowDragEnter(event: DragEvent) {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault(); draggingFiles.value = true;
}
function onWindowDragOver(event: DragEvent) {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = dropReady.value ? 'copy' : 'none';
  draggingFiles.value = true;
}
function onWindowDragLeave(event: DragEvent) {
  if (event.relatedTarget === null) closeDropOverlay();
}
function onWindowDrop(event: DragEvent) {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
  const files = [...(event.dataTransfer?.files || [])];
  closeDropOverlay();
  if (!dropReady.value) {
    emit('error', !studio.accountReady ? t('composer.drop.waitChat')
      : uploading.value ? t('composer.drop.waitUpload') : t('composer.drop.modelUnsupported'));
    return;
  }
  if (dropFields.value.length > 1) { emit('error', t('composer.drop.targetRequired')); return; }
  void uploadFiles(files, dropFields.value[0]);
}
function dropIntoField(event: DragEvent, field: MediaField) {
  event.preventDefault(); event.stopPropagation();
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
  window.removeEventListener('dragenter', onWindowDragEnter);
  window.removeEventListener('dragover', onWindowDragOver);
  window.removeEventListener('dragleave', onWindowDragLeave);
  window.removeEventListener('drop', onWindowDrop);
});
</script>

<template>
  <div v-if="hasSourcePicker || studio.sourceFiles.length || uploading" class="source-strip">
    <label v-if="studio.provider === 'codex' && hasSourcePicker" class="attach-button">＋ {{ t('composer.sources') }}<input type="file" accept="image/png,image/jpeg,image/webp" multiple @change="addFiles($event)" /></label>
    <template v-else>
      <FrameSourcePicker v-if="frameFields" :fields="frameFields" @selected="uploadFiles" />
      <label v-for="field in otherFileFields" :key="field.key" class="attach-button">＋ {{ sourceButtonLabel(field) }}{{ field.required ? ' *' : '' }}<input type="file" :accept="field.accept" :multiple="!field.scalar && field.maxFiles !== 1" @change="addFiles($event, field)" /></label>
    </template>
    <span v-if="uploading" class="uploading">{{ t('composer.uploading') }}</span>
    <article v-for="(file, index) in studio.sourceFiles" :key="file.ref + index" class="source-preview">
      <img v-if="file.type.startsWith('image/')" :src="sourcePreviewUrl(file.ref)" :alt="t('composer.thumbnail', { name: file.name })" loading="lazy">
      <span v-else class="source-file-icon" aria-hidden="true">▧</span>
      <button type="button" class="source-remove" :aria-label="t('composer.removeFile', { name: file.name })" @click="removeFile(index)">×</button>
    </article>
  </div>
  <details v-for="field in apimartReferenceFields" :key="field.key" class="apimart-reference-details" :open="field.required || Boolean(apimartReferences(field))">
    <summary>{{ field.type === 'files' ? t('apimart.admin.addImageByUrl') : field.label || field.key }}{{ field.required ? ' *' : '' }}</summary>
    <label>{{ field.type === 'files' ? t('apimart.admin.imageUrls') : field.label || field.key }}
      <textarea :value="apimartReferences(field)" :placeholder="t('apimart.admin.sourceUrls')" @change="updateApimartReferences(field, $event)"></textarea>
    </label>
  </details>
  <Teleport to="body">
    <div v-if="draggingFiles" class="chat-drop-overlay" :class="{ unavailable: !dropReady }" @dragover.prevent>
      <section class="chat-drop-panel" role="status" aria-live="assertive">
        <span class="chat-drop-icon" aria-hidden="true">⇩</span>
        <strong>{{ dropTitle }}</strong>
        <p>{{ dropDescription }}</p>
        <div v-if="dropReady && dropFields.length > 1" class="chat-drop-targets">
          <article v-for="field in dropFields" :key="field.key" class="chat-drop-target"
            :class="{ active: activeDropFieldKey === field.key }"
            @dragenter.prevent="activeDropFieldKey = field.key" @dragleave="activeDropFieldKey = ''"
            @dragover.prevent="activeDropFieldKey = field.key" @drop="dropIntoField($event, field)">
            <strong>{{ dropFieldLabel(field) }}</strong>
            <small>{{ field.scalar || field.maxFiles === 1 ? t('composer.oneFile') : field.maxFiles ? t('composer.upToFiles', { count: field.maxFiles }) : t('composer.multipleFiles') }}</small>
          </article>
        </div>
      </section>
    </div>
  </Teleport>
</template>
