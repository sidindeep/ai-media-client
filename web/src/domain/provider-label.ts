import type { Catalog, GenerationRecord } from '../types';

export function generationProviderLabel(record: GenerationRecord, catalog: Catalog | null): string {
  if (record.kieAccountId && ['media', 'kie'].includes(record.providerId)) {
    return catalog?.kieAccounts?.find(account => account.id === record.kieAccountId)?.name
      || (record.kieAccountId === 'secondary' ? 'Kie.ai · Sid' : 'Kie.ai · 1');
  }
  return record.providerName || (record.providerId === 'codex' ? 'Codex' : record.providerId === 'media' ? 'Kie.ai' : record.providerId || '—');
}
