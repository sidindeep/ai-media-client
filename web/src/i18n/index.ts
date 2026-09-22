import { readonly, ref } from 'vue';
import { en } from './locales/en';
import { ru, type TranslationKey } from './locales/ru';

export type Locale = 'ru' | 'en';
export type TranslationParams = Record<string, string | number>;
type PluralCategory = Intl.LDMLPluralRule;
type PluralKey = { [Key in TranslationKey]: Key extends `${infer Prefix}.${PluralCategory}` ? Prefix : never }[TranslationKey];

const STORAGE_KEY = 'ai-media-client.locale';
const DEFAULT_LOCALE: Locale = 'ru';
const dictionaries = { ru, en } as const;
const activeLocale = ref<Locale>(DEFAULT_LOCALE);

function normalizeLocale(value: string | null | undefined): Locale | null {
  const normalized = value?.trim().toLowerCase().replace('_', '-');
  if (!normalized) return null;
  if (normalized === 'ru' || normalized.startsWith('ru-') || normalized === 'rus') return 'ru';
  if (normalized === 'en' || normalized.startsWith('en-') || normalized === 'eng') return 'en';
  return null;
}

function preferredLocale(): Locale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE;
  const stored = normalizeLocale(window.localStorage.getItem(STORAGE_KEY));
  if (stored) return stored;
  for (const candidate of window.navigator.languages || [window.navigator.language]) {
    const normalized = normalizeLocale(candidate);
    if (normalized) return normalized;
  }
  return DEFAULT_LOCALE;
}

function interpolate(message: string, params: TranslationParams = {}) {
  return message.replace(/\{([a-zA-Z][\w-]*)\}/g, (placeholder, name: string) => (
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : placeholder
  ));
}

function applyLocale(locale: Locale) {
  activeLocale.value = locale;
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, locale);
    window.dispatchEvent(new CustomEvent('ai-media-locale-change', { detail: { locale } }));
  }
}

export function initializeI18n() {
  applyLocale(preferredLocale());
}

export function setLocale(locale: Locale | 'eng' | 'rus') {
  applyLocale(normalizeLocale(locale) || DEFAULT_LOCALE);
}

export function t(key: TranslationKey, params?: TranslationParams): string {
  const message = dictionaries[activeLocale.value][key] ?? dictionaries[DEFAULT_LOCALE][key];
  return interpolate(message, params);
}

export function tp(key: PluralKey, count: number, params: TranslationParams = {}) {
  const category = new Intl.PluralRules(activeLocale.value).select(count);
  const candidate = `${key}.${category}` as TranslationKey;
  const fallback = `${key}.other` as TranslationKey;
  const dictionary = dictionaries[activeLocale.value] as Record<string, string>;
  return interpolate(dictionary[candidate] ?? dictionary[fallback] ?? dictionaries[DEFAULT_LOCALE][fallback], { ...params, count });
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions) {
  return new Intl.NumberFormat(activeLocale.value, options).format(value);
}

export function formatDate(value: Date | number | string, options?: Intl.DateTimeFormatOptions) {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat(activeLocale.value, options).format(date);
}

export function localizeElement(root: ParentNode) {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach(element => {
    element.textContent = t(element.dataset.i18n as TranslationKey);
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-html]').forEach(element => {
    element.innerHTML = t(element.dataset.i18nHtml as TranslationKey);
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-own]').forEach(element => {
    const textNode = [...element.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
    if (textNode) textNode.textContent = t(element.dataset.i18nOwn as TranslationKey);
  });
  const attributes = ['aria-label', 'title', 'placeholder'] as const;
  for (const attribute of attributes) {
    const datasetName = `i18n${attribute.split('-').map(part => part[0].toUpperCase() + part.slice(1)).join('')}`;
    root.querySelectorAll<HTMLElement>(`[data-i18n-${attribute}]`).forEach(element => {
      const key = element.dataset[datasetName] as TranslationKey;
      element.setAttribute(attribute, t(key));
    });
  }
}

export const locale = readonly(activeLocale);
export const supportedLocales = ['ru', 'en'] as const;

export function useI18n() {
  return { locale, supportedLocales, setLocale, t, tp, formatNumber, formatDate, localizeElement };
}

export type { TranslationKey };
