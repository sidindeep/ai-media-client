<script setup lang="ts">
import AppIcon from "./AppIcon.vue";
import { computed, ref } from 'vue';
import { saveSourceAttachment } from '../domain/source-attachments';
import { useI18n } from '../i18n';
import { parameterLabel } from '../i18n/parameter-labels';
import { useStudioStore } from '../stores/studio';
import { schemaInitialValue } from '../domain/model-ui-visibility';

type Schema = { type?: string; properties?: Record<string, Schema>; required?: string[]; items?: Schema;
  enum?: unknown[]; default?: unknown; minItems?: number; maxItems?: number; minimum?: number; maximum?: number;
  minLength?: number; maxLength?: number; description?: string; uiHidden?: boolean };
const props = defineProps<{ schema: Schema; modelValue?: unknown; label: string; name: string; rootKey: string; required?: boolean; error?: string; showHidden?: boolean }>();
const emit = defineEmits<{ change: [value: unknown]; uploaded: [file: { ref: string; name: string; type: string; fieldKey: string }] }>();
const studio = useStudioStore();
const { t } = useI18n();
const displayLabel = computed(() => parameterLabel(props.name, props.label));
const uploading = ref(false);
const uploadError = ref('');
const kind = computed(() => /image|mask/i.test(props.name) ? 'image' : /video/i.test(props.name) ? 'video' : /audio|voice/i.test(props.name) ? 'audio' : null);
const canUpload = computed(() => props.schema.type === 'string' && /url|image|audio|video|mask/i.test(props.name) && kind.value !== null);
const uploadedName = computed(() => studio.sourceFiles.find(file => file.ref === props.modelValue)?.name);
const items = computed(() => Array.isArray(props.modelValue) ? props.modelValue : []);
const objectValue = computed(() => props.modelValue && typeof props.modelValue === 'object' && !Array.isArray(props.modelValue)
  ? props.modelValue as Record<string, unknown> : {});
const visibleProperties = computed(() => Object.fromEntries(Object.entries(props.schema.properties || {})
  .filter(([, schema]) => props.showHidden || !schema.uiHidden)));
function changeItem(index: number, value: unknown) {
  const next = [...items.value]; next[index] = value; emit('change', next);
}
function changeProperty(key: string, value: unknown) {
  const next = { ...(schemaInitialValue(props.schema) as Record<string, unknown> || {}), ...objectValue.value };
  if (value === undefined) delete next[key]; else next[key] = value;
  emit('change', next);
}
function changeScalar(raw: string | boolean) {
  if (typeof raw === 'boolean') return emit('change', raw);
  if (raw === '') return emit('change', undefined);
  emit('change', ['number', 'integer'].includes(props.schema.type || '') ? Number(raw) : raw);
}
async function selectFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0]; input.value = '';
  if (!file) return;
  uploading.value = true; uploadError.value = '';
  try {
    const saved = await saveSourceAttachment(file, studio, props.rootKey);
    emit('uploaded', { ref: saved.ref, name: saved.name, type: saved.type, fieldKey: props.rootKey });
    emit('change', saved.ref);
  } catch (error) { uploadError.value = error instanceof Error ? error.message : t('composer.files.uploadError'); }
  finally { uploading.value = false; }
}
</script>

<template>
  <div v-if="showHidden || !schema.uiHidden" class="schema-field">
    <span class="schema-field-label">{{ displayLabel }}{{ required ? ' *' : '' }}<small v-if="showHidden && schema.uiHidden"> ({{ t('composer.hiddenForUser') }})</small></span>
    <small v-if="error" class="field-error">{{ error }}</small>
    <div v-if="schema.type === 'array'" class="schema-field-items">
      <div v-for="(item, index) in items" :key="index" class="schema-field-item">
        <SchemaField :schema="schema.items || {}" :model-value="item" :label="`${label} ${index + 1}`" :name="name" :root-key="rootKey"
          required :show-hidden="showHidden" @change="changeItem(index, $event)" @uploaded="emit('uploaded', $event)" />
        <button type="button" @click="emit('change', items.filter((_, itemIndex) => itemIndex !== index))">{{ t('composer.structured.remove') }}</button>
      </div>
      <button type="button" :disabled="schema.maxItems !== undefined && items.length >= schema.maxItems"
        @click="emit('change', [...items, schemaInitialValue(schema.items)])">{{ t('composer.structured.add') }}</button>
    </div>
    <div v-else-if="schema.type === 'object'" class="schema-field-object">
      <SchemaField v-for="(property, key) in visibleProperties" :key="key" :schema="property" :model-value="objectValue[key]"
        :label="String(key)" :name="String(key)" :root-key="rootKey" :required="schema.required?.includes(String(key))"
        :show-hidden="showHidden" @change="changeProperty(String(key), $event)" @uploaded="emit('uploaded', $event)" />
    </div>
    <select v-else-if="schema.enum?.length" :value="modelValue === undefined ? '' : String(modelValue)" @change="changeScalar(($event.target as HTMLSelectElement).value)">
      <option value="">—</option>
      <option v-for="option in schema.enum" :key="String(option)" :value="String(option)">{{ option }}</option>
    </select>
    <input v-else-if="schema.type === 'boolean'" type="checkbox" :checked="Boolean(modelValue)" @change="changeScalar(($event.target as HTMLInputElement).checked)" />
    <input v-else-if="schema.type === 'number' || schema.type === 'integer'" type="number" :step="schema.type === 'integer' ? 1 : 'any'"
      :min="schema.minimum" :max="schema.maximum" :value="modelValue ?? ''" @input="changeScalar(($event.target as HTMLInputElement).value)" />
    <textarea v-else-if="name === 'prompt' || name === 'text'" :value="String(modelValue ?? '')" :maxlength="schema.maxLength"
      @input="changeScalar(($event.target as HTMLTextAreaElement).value)"></textarea>
    <input v-else type="text" :value="String(modelValue ?? '')" :maxlength="schema.maxLength"
      @input="changeScalar(($event.target as HTMLInputElement).value)" />
    <label v-if="canUpload" class="attach-button"><AppIcon name="add" /> {{ t('composer.structured.upload') }}
      <input type="file" :accept="`${kind}/*`" :disabled="uploading" @change="selectFile" />
    </label>
    <small v-if="uploadedName">{{ t('composer.structured.uploaded', { name: uploadedName }) }}</small>
    <small v-if="uploadError" class="field-error">{{ uploadError }}</small>
    <small v-else-if="schema.description && schema.description.length < 240">{{ schema.description }}</small>
  </div>
</template>
