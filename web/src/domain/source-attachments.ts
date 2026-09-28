import { uploadSource } from '../api/client';
import type { MediaField } from '../types';

export type SourceContext = { activeProjectId: string | null; activeChatId: string | null };

export async function saveSourceAttachment(file: File, context: SourceContext, fieldKey?: string) {
  const saved = await uploadSource(file, {
    projectId: context.activeProjectId,
    chatId: context.activeChatId === 'system:recent' ? null : context.activeChatId,
  });
  return { ...saved, ref: saved.ref, name: file.name, type: file.type,
    ...(fieldKey ? { fieldKey } : {}) };
}

export function sourcePreviewUrl(ref: string) {
  const assetId = /^content:([a-f0-9-]{36})$/.exec(ref)?.[1];
  if (assetId) return `/api/content/${assetId}`;
  const id = /^https:\/\/local-assets\.invalid\/([a-f0-9]{64})$/.exec(ref)?.[1];
  return id ? `/api/sources/${id}` : '';
}

export function isReferenceField(field: MediaField) {
  return /image|video|audio|mask/.test(field.key)
    && (['string', 'files'].includes(field.type || '') && /url|frame|mask/.test(field.key)
      || field.schema?.type === 'array' && (field.schema.items as { type?: string } | undefined)?.type === 'string');
}
