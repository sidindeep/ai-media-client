import type { MediaField } from '../types';
import { mediaFieldOptions } from './media-fields';

export function videoPrimaryFields(fields: MediaField[]) {
  const find = (keys: string[]) => keys.map(key => fields.find(field => field.key === key)).find(Boolean);
  return {
    aspect: find(['aspect_ratio', 'aspectRatio', 'ratio', 'size']),
    quality: find(['resolution', 'output_resolution', 'quality'])
      || fields.find(field => field.key === 'mode' && (field.label === 'Качество'
        || mediaFieldOptions(field).some(value => /^\d+(?:p|k)$/i.test(String(value))))),
    duration: find(['duration', 'duration_seconds', 'durationSeconds', 'video_duration']),
  };
}

function catalogDurationOptions(field?: MediaField): unknown[] {
  if (!field) return [];
  const options = mediaFieldOptions(field);
  if (options.length) return options;
  const min = Number(field.min ?? field.schema?.minimum);
  const max = Number(field.max ?? field.schema?.maximum);
  const step = Number(field.step ?? 1);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max || !Number.isFinite(step) || step <= 0) return [];
  const count = Math.floor((max - min) / step) + 1;
  if (count > 120) return [];
  return Array.from({ length: count }, (_, index) => {
    const value = Number((min + index * step).toPrecision(12));
    return field.schema?.type === 'string' ? String(value) : value;
  });
}

export function videoDurationOptions(field?: MediaField): unknown[] {
  return catalogDurationOptions(field).filter(value => {
    const seconds = Number(value);
    return Number.isFinite(seconds) ? seconds > 0 : String(value).trim().toLowerCase() !== 'auto';
  });
}
