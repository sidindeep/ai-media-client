import { t, type TranslationKey } from './index';
import { ru } from './locales/ru';
import type { MediaField } from '../types';

const nestedKeys: Record<string, TranslationKey> = {
  speaker_id: 'composer.structured.field.speakerId', voice_name: 'composer.structured.field.voiceName',
  audio_profile: 'composer.structured.field.audioProfile', accent: 'composer.structured.field.accent',
  style: 'composer.structured.field.style', pace: 'composer.structured.field.pace',
  text: 'composer.structured.field.text', voice: 'composer.structured.field.voice',
  image_url: 'composer.structured.field.image', type: 'composer.structured.field.type',
  ref_name: 'composer.structured.field.referenceName',
};

/** Translate technical labels only; preserve model-specific captions and item numbers. */
export function parameterLabel(name: string, label = name): string {
  if (label.trim() !== name.trim() && label !== 'Seed') return label;
  const normalized = name.trim();
  const nestedKey = nestedKeys[normalized];
  if (nestedKey) return t(nestedKey);
  const key = `composer.parameter.${normalized === 'Seed' ? 'seed' : normalized}`;
  return key in ru ? t(key as TranslationKey) : label;
}

export function localizeParameterFields(fields: MediaField[]): MediaField[] {
  return fields.map(field => ({ ...field, label: parameterLabel(field.key, field.label || field.key) }));
}
