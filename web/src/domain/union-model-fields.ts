import type { MediaField, MediaModel } from '../types';
import { t } from '../i18n';
import { localizeParameterFields, parameterLabel } from '../i18n/parameter-labels';

type InputSchema = Variant & { oneOf?: Variant[]; anyOf?: Variant[]; allOf?: Conditional[] };
type Variant = { title?: string; required?: string[]; properties?: Record<string, Record<string, unknown>> };
type Conditional = { if?: Variant; then?: Variant; else?: Variant };

// Project conditional requirements use JSON Schema property const predicates.
// Read those same predicates instead of duplicating model rules in the form.
function conditionalRequired(schema: InputSchema | undefined, input: Record<string, unknown>): string[] {
  return (schema?.allOf || []).flatMap(rule => {
    if (!rule.if?.properties || Object.values(rule.if.properties).some(property => !Object.hasOwn(property, 'const'))) return [];
    const matches = (rule.if.required || []).every(key => input[key] !== undefined)
      && Object.entries(rule.if.properties).every(([key, property]) => input[key] === undefined || input[key] === property.const);
    return (matches ? rule.then : rule.else)?.required || [];
  });
}

const labelKeys: Record<string, string> = {
  prompt: 'prompt', task_id: 'task', taskId: 'task', image_url: 'image', image_urls: 'images',
  video_url: 'video', video_urls: 'videos', duration: 'duration', quality: 'quality',
  resolution: 'resolution', aspect_ratio: 'aspectRatio', audio: 'audio',
};

export function unionVariants(model?: MediaModel): Variant[] {
  const schema = model?.inputSchema as InputSchema | undefined;
  return (schema?.oneOf || schema?.anyOf || []).map(variant => ({ ...variant,
    // Suno input modes also have common required properties at schema root.
    properties: { ...schema?.properties, ...variant.properties },
    required: [...new Set([...(schema?.required || []), ...(variant.required || [])])],
  }));
}

export function unionFields(model: MediaModel | undefined, index: number, input: Record<string, unknown> = {}): MediaField[] {
  const variant = unionVariants(model)[index];
  if (!variant) return localizeParameterFields(model?.fields || []);
  const conditionallyRequired = conditionalRequired(model?.inputSchema as InputSchema | undefined, input);
  return Object.entries(variant.properties || {}).map(([key, schema]) => {
    const valueType = schema.type;
    const isMedia = /^(?:image|video|audio)(?:_url|_urls)$/.test(key);
    const isFile = isMedia && (valueType === 'string' || valueType === 'array' &&
      (schema.items as { type?: string } | undefined)?.type === 'string');
    const options = Array.isArray(schema.enum) ? schema.enum as Array<string | number | boolean> : undefined;
    const type = isFile ? 'files' : options?.length ? 'select' : valueType === 'boolean' ? 'boolean'
      : valueType === 'number' || valueType === 'integer' ? 'number'
        : valueType === 'array' || valueType === 'object' ? 'json'
          : key === 'prompt' ? 'textarea' : 'text';
    return {
      key, label: labelKeys[key] ? t(`composer.unionField.${labelKeys[key]}` as Parameters<typeof t>[0]) : parameterLabel(key),
      type, schema, required: variant.required?.includes(key) || conditionallyRequired.includes(key),
      uiHidden: schema.uiHidden === true,
      uiHiddenReason: typeof schema.uiHiddenReason === 'string' ? schema.uiHiddenReason : undefined,
      uiVisibleReason: typeof schema.uiVisibleReason === 'string' ? schema.uiVisibleReason : undefined,
      default: schema.default, options, scalar: valueType === 'string',
      maxFiles: valueType === 'string' ? 1 : typeof schema.maxItems === 'number' ? schema.maxItems : undefined,
      accept: isFile ? key.startsWith('image') ? 'image/*' : key.startsWith('video') ? 'video/*' : 'audio/*' : undefined,
      min: typeof schema.minimum === 'number' ? schema.minimum : undefined,
      max: typeof schema.maximum === 'number' ? schema.maximum : undefined,
    };
  });
}
