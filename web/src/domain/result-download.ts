import type { GenerationRecord } from '../types';

export function resultDownloadUrl(record: GenerationRecord | null | undefined, index: number, previewUrl: string): string {
  if (!record) return previewUrl;
  if (record.providerId === 'media' || record.providerId === 'kie') {
    return `/api/results/${encodeURIComponent(record.id)}/${index}?download=1`;
  }
  return record.localFiles?.[index]?.url || previewUrl;
}
