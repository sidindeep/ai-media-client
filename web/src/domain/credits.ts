import { formatNumber } from '../i18n';

export function roundedCreditCost(value: number) {
  return Math.ceil(value);
}

export function formatCreditCost(value: number) {
  return formatNumber(roundedCreditCost(value));
}
