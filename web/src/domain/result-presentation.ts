import type { GenerationRecord } from '../types';
import { t } from '../i18n';

export function resultModelLabel(record: GenerationRecord, admin: boolean) {
  return record.modelName || (admin ? record.modelId : '') || t('navigation.generation');
}

export function publicResultError(record: GenerationRecord) {
  const error = record.error || '';
  if (/недостаточно\s+кредит/i.test(error)) return publicServiceError(error);
  if (record.state === 'blocked') return t('error.resultBlocked');
  if (record.state === 'cancelled') return t('error.resultCancelled');
  if (record.state === 'unknown' || record.state === 'unconfirmed') return t('error.resultUnknown');
  return t('error.resultFallback');
}

export function publicServiceError(message: string, fallback = t('error.requestFallback')) {
  if (/недостаточно\s+кредит/i.test(message)) return t('error.insufficientCredits');
  return fallback;
}

export function resultError(record: GenerationRecord, admin: boolean) {
  return admin && record.error ? record.error : publicResultError(record);
}
