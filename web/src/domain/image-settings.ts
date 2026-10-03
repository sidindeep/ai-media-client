import type { MediaField } from '../types';
import { mediaFieldOptions } from './media-fields';
import type { IconName } from '../icons';

export function imagePrimaryFields(fields: MediaField[], provider: string): MediaField[] {
  if (!['media', 'apimart'].includes(provider)) return [];
  const pattern = provider === 'apimart'
    ? /^(size|aspect_ratio|resolution|quality|mode|version|duration|voice)$/
    : /aspect|ratio|format|resolution|quality|^size$/i;
  return fields.filter((field, index) => pattern.test(field.key) && mediaFieldOptions(field).length
    && fields.findIndex(item => item.key === field.key) === index).slice(0, provider === 'apimart' ? 3 : 2);
}

export function parameterIcon(field: MediaField): IconName | undefined {
  const key = field.key.replace(/_/g, '').toLowerCase();
  if (['aspectratio', 'ratio'].includes(key)) return 'aspect-ratio';
  if (['resolution', 'outputresolution', 'imagesize'].includes(key)) return 'resolution';
  if (['duration', 'durationseconds', 'videoduration'].includes(key)) return 'duration';
  if (key === 'effort') return 'parameters';
  if (key === 'speed') return 'lightning';
  if (!['size', 'format', 'quality', 'mode'].includes(key)) return undefined;
  const choices = mediaFieldOptions(field).flatMap(option => [String(option), String(field.optionLabels?.[String(option)] || '')]);
  if (choices.some(option => /^\d+:\d+$|^(square|portrait|landscape)$/i.test(option.trim()))) return 'aspect-ratio';
  if (choices.some(option => /^\d+(p|k)$|^\d+\s*[x×]\s*\d+$/i.test(option.trim()))) return 'resolution';
  return key === 'quality' ? 'star' : undefined;
}
