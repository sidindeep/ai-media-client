import type { MediaField, RouterAiCatalog } from '../types';
import { mediaFieldOptions } from './media-fields';

export type AdvancedParameter = {
  key: string;
  label: string;
  kind: 'select' | 'number' | 'boolean' | 'text' | 'textarea' | 'json' | 'file';
  required?: boolean;
  hint?: string;
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  step?: number | string;
  maxLength?: number;
  accept?: string;
};

export function mediaAdvancedParameters(fields: MediaField[], optionLabel: (field: MediaField, option: unknown) => string): AdvancedParameter[] {
  return fields.map(field => {
    const options = mediaFieldOptions(field);
    return {
      key: field.key,
      label: field.label || field.key,
      kind: options.length ? 'select' : field.type === 'number' ? 'number' : field.type === 'boolean' ? 'boolean'
        : field.type === 'json' ? 'json' : field.type === 'textarea' ? 'textarea' : 'text',
      required: field.required,
      hint: field.hint,
      options: options.map(value => ({ value: String(value), label: optionLabel(field, value) })),
      min: field.min,
      max: field.max,
      step: field.step,
      maxLength: field.maxLength,
    };
  });
}

export function routerAiAdvancedParameters(model: RouterAiCatalog['models'][number] | undefined, labels: {
  audioFile: string; duration: string; seconds: string; resolution: string; aspectRatio: string; body: string; parametersHint: string;
}): AdvancedParameter[] {
  if (!model || model.kind === 'text' || model.kind === 'image') return [];
  if (model.kind !== 'video') return [
    ...(model.kind === 'transcription' ? [{ key: 'audioFile', label: labels.audioFile, kind: 'file' as const, accept: 'audio/*' }] : []),
    { key: 'body', label: labels.body, kind: 'json' as const, hint: labels.parametersHint },
  ];
  const select = (key: string, label: string, values: Array<string | number> | undefined, suffix = ''): AdvancedParameter[] =>
    values?.length ? [{ key, label, kind: 'select', options: values.map(value => ({ value: String(value), label: `${value}${suffix}` })) }] : [];
  return [
    ...select('duration', labels.duration, model.supportedDurations, ` ${labels.seconds}`),
    ...select('resolution', labels.resolution, model.supportedResolutions),
    ...select('aspect_ratio', labels.aspectRatio, model.supportedAspectRatios),
  ];
}
