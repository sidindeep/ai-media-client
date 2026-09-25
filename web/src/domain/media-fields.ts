import type { MediaField } from '../types';
import { t } from '../i18n';

export function mediaFieldOptions(field: MediaField): unknown[] {
  return field.options || field.schema?.enum || [];
}

function matchesOption(option: unknown, value: unknown) {
  return typeof option === 'number' || typeof value === 'number'
    ? Number(option) === Number(value)
    : String(option) === String(value);
}

export function mediaFieldValueError(field: MediaField, value: unknown): string {
  if (value === '' || value === null || value === undefined) return '';
  const options = mediaFieldOptions(field);
  if (options.length && !options.some(option => matchesOption(option, value))) {
    return t('validation.allowedValues', { values: options.map(option => Number(option) <= 0 ? t('validation.auto') : String(option)).join(', ') });
  }
  if (field.type === 'number' || field.schema?.type === 'number' || field.schema?.type === 'integer') {
    const number = Number(value);
    if (!Number.isFinite(number)) return t('validation.number');
    const minimum = Number(field.min ?? field.schema?.minimum);
    const maximum = Number(field.max ?? field.schema?.maximum);
    if (Number.isFinite(minimum) && number < minimum) return t('validation.minimum', { value: minimum });
    if (Number.isFinite(maximum) && number > maximum) return t('validation.maximum', { value: maximum });
  }
  return '';
}

export function normalizeMediaInput(fields: MediaField[], input: Record<string, unknown>) {
  const normalized = { ...input };
  for (const field of fields) {
    if (field.type === 'files') {
      const value = normalized[field.key];
      if (value !== undefined && value !== null) {
        normalized[field.key] = mediaFileValue(field, Array.isArray(value) ? value : [value]);
      }
      continue;
    }
    const options = mediaFieldOptions(field);
    const value = normalized[field.key];
    if (!options.length || value === '' || value === null || value === undefined || options.some(option => matchesOption(option, value))) continue;
    const fallback = field.default !== undefined && options.some(option => matchesOption(option, field.default))
      ? field.default
      : options[0];
    normalized[field.key] = fallback;
  }
  return normalized;
}

export function mediaFileValue(field: MediaField, refs: unknown[]): string | unknown[] | undefined {
  if (!refs.length) return undefined;
  // Cardinality (maxFiles) does not determine the wire type: a one-file field
  // can still require an array containing one URL.
  const scalar = field.schema?.type === 'array' ? false : field.schema?.type === 'string' ? true : field.scalar === true;
  return scalar ? String(refs[0]) : refs;
}

export function mediaSourceDurationRange(field?: MediaField): { min: number; max: number } | null {
  if (!field || field.type !== 'files' || !/video|audio/i.test(field.accept || field.key)) return null;
  const description = `${field.hint || ''} ${String(field.schema?.description || '')}`;
  const bracketed = description.match(/duration[^\n]{0,80}?\[\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\]\s*(?:s|sec(?:ond)?s?\b)/i);
  const ranged = description.match(/duration[^\n]{0,80}?(?:between|range:?|from)\s*`?(\d+(?:\.\d+)?)`?\s*(?:s|sec(?:ond)?s?)?\s*(?:to|[-–—])\s*`?(\d+(?:\.\d+)?)`?\s*(?:s|sec(?:ond)?s?\b)/i);
  const match = bracketed || ranged;
  if (!match) return null;
  const min = Number(match[1]), max = Number(match[2]);
  return Number.isFinite(min) && Number.isFinite(max) && min <= max ? { min, max } : null;
}

export function parseMediaFieldValue(field: MediaField, raw: unknown): unknown {
  if (field.type === 'boolean') return Boolean(raw);
  if (raw === '' || raw === null || raw === undefined) return undefined;
  const schemaType = field.schema?.type;
  if (field.type === 'number' || schemaType === 'number' || schemaType === 'integer') {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(t('validation.number'));
    return schemaType === 'integer' ? Math.trunc(value) : value;
  }
  if (field.type === 'json') {
    if (typeof raw !== 'string') return raw;
    try { return JSON.parse(raw); } catch { throw new Error(t('validation.json')); }
  }
  if (schemaType === 'boolean') {
    if (raw === true || raw === 'true') return true;
    if (raw === false || raw === 'false') return false;
  }
  return raw;
}

export function formatMediaFieldValue(field: MediaField, value: unknown): string | number | boolean {
  if (value === null || value === undefined) return '';
  if (field.type === 'json' && typeof value !== 'string') return JSON.stringify(value, null, 2);
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return JSON.stringify(value);
}
