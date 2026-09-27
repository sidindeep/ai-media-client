import type { MediaField, MediaModel } from '../types';
import { t } from '../i18n';

type InputSchema = { oneOf?: Record<string, unknown>[]; anyOf?: Record<string, unknown>[] };
type Variant = { title?: string; required?: string[]; properties?: Record<string, Record<string, unknown>> };

const labelKeys: Record<string, string> = {
  prompt: 'prompt', task_id: 'task', taskId: 'task', image_url: 'image', image_urls: 'images',
  video_url: 'video', video_urls: 'videos', duration: 'duration', quality: 'quality',
  resolution: 'resolution', aspect_ratio: 'aspectRatio', audio: 'audio',
};

export function unionVariants(model?: MediaModel): Variant[] {
  const schema = model?.inputSchema as InputSchema | undefined;
  return (schema?.oneOf || schema?.anyOf || []) as Variant[];
}

export function unionFields(model: MediaModel | undefined, index: number): MediaField[] {
  const variant = unionVariants(model)[index];
  if (!variant) return model?.fields || [];
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
      key, label: labelKeys[key] ? t(`composer.unionField.${labelKeys[key]}` as Parameters<typeof t>[0]) : key,
      type, schema, required: variant.required?.includes(key) || false,
      default: schema.default, options, scalar: valueType === 'string',
      maxFiles: valueType === 'string' ? 1 : typeof schema.maxItems === 'number' ? schema.maxItems : undefined,
      accept: isFile ? key.startsWith('image') ? 'image/*' : key.startsWith('video') ? 'video/*' : 'audio/*' : undefined,
      min: typeof schema.minimum === 'number' ? schema.minimum : undefined,
      max: typeof schema.maximum === 'number' ? schema.maximum : undefined,
    };
  });
}
