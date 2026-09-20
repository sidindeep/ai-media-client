import type { MediaField } from '../types';

export function mediaFieldOptions(field: MediaField): unknown[] {
  return field.options || field.schema?.enum || [];
}

export function parseMediaFieldValue(field: MediaField, raw: unknown): unknown {
  if (field.type === 'boolean') return Boolean(raw);
  if (raw === '' || raw === null || raw === undefined) return undefined;
  const schemaType = field.schema?.type;
  if (field.type === 'number' || schemaType === 'number' || schemaType === 'integer') {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error('Введите число');
    return schemaType === 'integer' ? Math.trunc(value) : value;
  }
  if (field.type === 'json') {
    if (typeof raw !== 'string') return raw;
    try { return JSON.parse(raw); } catch { throw new Error('Некорректный JSON'); }
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
