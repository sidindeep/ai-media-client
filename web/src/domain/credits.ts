import { formatNumber } from '../i18n';

export function roundedCreditCost(value: number) {
  return Math.ceil(value * 1000 - 1e-9) / 1000;
}

export function formatCreditCost(value: number) {
  return formatNumber(roundedCreditCost(value), { maximumFractionDigits: 3 });
}
