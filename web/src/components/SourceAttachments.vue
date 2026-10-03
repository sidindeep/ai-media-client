<script setup lang="ts">
import AppIcon from "./AppIcon.vue";
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { MediaField } from '../types';
import { useStudioStore } from '../stores/studio';
import { useI18n } from '../i18n';
import { mediaFileValue, mediaSourceDurationRange } from '../domain/media-fields';
import { frameFieldPair, orderedFileFields } from '../domain/frame-fields';
import { isReferenceField, saveSourceAttachment, sourcePreviewUrl } from '../domain/source-attachments';

const props = defineProps<{ fields: MediaField[]; inputFields?: MediaField[] }>();
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
const visibleSources = computed(() => studio.sourceFiles.map((file, index) => ({ ...file, sourceIndex: index }))
  .filter(file => !['media', 'apimart'].includes(studio.provider) || !file.fieldKey
    || props.fields.some(field => field.key === file.fieldKey)));
// Role/view changes only alter presentation; they must not clean saved inputs.
watch(() => [studio.provider, props.inputFields || props.fields] as const, () => {
  if (studio.provider !== 'apimart') return;
  const input = { ...studio.mediaInput };
  let changed = false;
  for (const field of (props.inputFields || props.fields).filter(field => !field.uiHidden && !field.uiVisibleReason && isReferenceField(field))) {
    if (!(field.key in input)) continue;
    const refs = new Set(studio.sourceFiles.filter(file => file.fieldKey === field.key).map(file => file.ref));
    const previous = input[field.key];
    const values = (Array.isArray(previous) ? previous : [previous]).filter(value => refs.has(String(value)));
    const next = field.type === 'files' ? mediaFileValue(field, values) : undefined;
    if (next === undefined) delete input[field.key]; else input[field.key] = next;
    changed = true;
  }
  if (changed) studio.mediaInput = input;
}, { immediate: true });
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
  if (field.uiHidden) return field.label || t('composer.sources');
  return fileFields.value.length === 1 ? t('composer.sources') : field.label || t('composer.sources');
}
function dropFieldLabel(field: MediaField) {
  if (field === frameFields.value?.[0]) return t('composer.frame.first');
  if (field === frameFields.value?.[1]) return t('composer.frame.last');
  return field.label || field.key;
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
  <div v-if="hasSourcePicker || visibleSources.length || uploading" class="source-strip">
    <label v-if="studio.provider === 'codex' && hasSourcePicker" class="attach-button"><AppIcon name="add" /> {{ t('composer.sources') }}<input type="file" accept="image/png,image/jpeg,image/webp" multiple @change="addFiles($event)" /></label>
    <template v-else>
      <FrameSourcePicker v-if="frameFields" :fields="frameFields" @selected="uploadFiles" />
      <label v-for="field in otherFileFields" :key="field.key" class="attach-button"><AppIcon name="add" /> {{ sourceButtonLabel(field) }}{{ field.required ? ' *' : '' }}<input type="file" :accept="field.accept" :multiple="!field.scalar && field.maxFiles !== 1" @change="addFiles($event, field)" /></label>
    </template>
    <span v-if="uploading" class="uploading">{{ t('composer.uploading') }}</span>
    <article v-for="file in visibleSources" :key="file.ref + file.sourceIndex" class="source-preview">
      <img v-if="file.type.startsWith('image/')" :src="sourcePreviewUrl(file.ref)" :alt="t('composer.thumbnail', { name: file.name })" loading="lazy">
      <span v-else class="source-file-icon" aria-hidden="true"><AppIcon :name="file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : 'text'" /></span>
      <button type="button" class="source-remove" :aria-label="t('composer.removeFile', { name: file.name })" @click="removeFile(file.sourceIndex)"><AppIcon name="close" /></button>
    </article>
  </div>
  <Teleport to="body">
    <div v-if="draggingFiles" class="chat-drop-overlay" :class="{ unavailable: !dropReady }" @dragover.prevent>
      <section class="chat-drop-panel" role="status" aria-live="assertive">
        <span class="chat-drop-icon" aria-hidden="true"><AppIcon name="upload" /></span>
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
