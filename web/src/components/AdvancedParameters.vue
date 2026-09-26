<script setup lang="ts">
import type { AdvancedParameter } from '../domain/advanced-parameters';
import { useI18n } from '../i18n';

defineProps<{
  fields: AdvancedParameter[];
  values: Record<string, unknown>;
  errors?: Record<string, string>;
  context?: string;
}>();
const emit = defineEmits<{
  change: [key: string, value: unknown];
}>();
const { t } = useI18n();
</script>

<template>
  <details v-if="fields.length" class="advanced-settings">
    <summary>{{ t('composer.advanced') }}</summary>
    <div class="advanced-grid">
      <p v-if="context" class="advanced-context">{{ context }}</p>
      <label v-for="field in fields" :key="field.key" :class="{ invalid: errors?.[field.key] }">
        <span>{{ field.label }}{{ field.required ? ' *' : '' }}</span>
        <select v-if="field.kind === 'select'" :value="values[field.key] ?? ''" @change="emit('change', field.key, ($event.target as HTMLSelectElement).value)">
          <option v-for="option in field.options" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
        <input v-else-if="field.kind === 'number'" type="number" :min="field.min" :max="field.max" :step="field.step" :value="values[field.key] ?? ''" @input="emit('change', field.key, ($event.target as HTMLInputElement).value)" />
        <input v-else-if="field.kind === 'boolean'" type="checkbox" :checked="Boolean(values[field.key])" @change="emit('change', field.key, ($event.target as HTMLInputElement).checked)" />
        <input v-else-if="field.kind === 'file'" type="file" :accept="field.accept" @change="emit('change', field.key, ($event.target as HTMLInputElement).files?.[0] || null)" />
        <textarea v-else-if="field.kind === 'textarea' || field.kind === 'json'" :maxlength="field.maxLength" :rows="field.kind === 'json' ? 6 : undefined" :spellcheck="field.kind !== 'json'" :value="String(values[field.key] ?? '')" @change="emit('change', field.key, ($event.target as HTMLTextAreaElement).value)"></textarea>
        <input v-else type="text" :maxlength="field.maxLength" :value="String(values[field.key] ?? '')" @input="emit('change', field.key, ($event.target as HTMLInputElement).value)" />
        <small v-if="errors?.[field.key]" class="field-error">{{ errors[field.key] }}</small>
        <small v-else-if="field.hint">{{ field.hint }}</small>
      </label>
    </div>
  </details>
</template>
