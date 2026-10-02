import type { MediaField } from '../types';

export type UiSchema = { type?: string; properties?: Record<string, UiSchema>; required?: string[];
  items?: UiSchema; default?: unknown; uiHidden?: boolean };

// UI filtering must never be used to normalize the API payload or saved draft.
export function userVisibleFields(fields: MediaField[], showHidden: boolean): MediaField[] {
  return showHidden ? fields : fields.filter(field => !field.uiHidden);
}

export function schemaInitialValue(schema?: UiSchema): unknown {
  if (schema?.default !== undefined) return structuredClone(schema.default);
  if (schema?.type === 'object') return Object.fromEntries(Object.entries(schema.properties || {})
    .flatMap(([key, child]) => {
      // Do not activate optional substructures or invent a required scalar value.
      const value = child.default !== undefined ? structuredClone(child.default) : undefined;
      return value === undefined ? [] : [[key, value]];
    }));
  if (schema?.type === 'array') return [];
  if (schema?.type === 'boolean') return false;
  return undefined;
}

export function hiddenRequiredPaths(fields: MediaField[], input: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const missing = (value: unknown) => value == null || value === '' || Array.isArray(value) && !value.length;
  function visit(schema: UiSchema, value: unknown, path: string, required: boolean, hidden: boolean) {
    hidden ||= schema.uiHidden === true;
    if (required && hidden && missing(value)) { paths.push(path); return; }
    if (missing(value) && !required) return;
    if (schema.type === 'array' && Array.isArray(value) && schema.items) {
      value.forEach((item, index) => visit(schema.items!, item, `${path}[${index}]`, true, hidden));
    } else if (schema.type === 'object') {
      const object = value && typeof value === 'object' ? value as Record<string, unknown> : {};
      for (const [key, child] of Object.entries(schema.properties || {})) {
        visit(child, object[key], `${path}.${key}`, Boolean(schema.required?.includes(key)), hidden);
      }
    }
  }
  for (const field of fields) visit(field.schema || {}, input[field.key], field.key, Boolean(field.required), Boolean(field.uiHidden));
  return paths;
}
