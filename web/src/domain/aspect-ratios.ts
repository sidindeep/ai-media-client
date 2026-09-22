import { t, type TranslationKey } from '../i18n';

const ASPECT_RATIO_NAMES: Record<string, TranslationKey> = {
  auto: 'aspect.auto', '1:1': 'aspect.square', '16:9': 'aspect.horizontal', '9:16': 'aspect.vertical',
  '4:3': 'aspect.classic', '3:4': 'aspect.portrait', '21:9': 'aspect.cinema', '3:2': 'aspect.landscape',
  '2:3': 'aspect.portrait', '4:5': 'aspect.portrait', '5:4': 'aspect.landscape', '2:1': 'aspect.wide', '1:2': 'aspect.vertical',
};

export function aspectRatioName(value: unknown) {
  const key = ASPECT_RATIO_NAMES[String(value).toLowerCase()];
  return key ? t(key) : '';
}

export function isAspectRatioField(key: string) {
  return /aspect.*ratio|ratio.*aspect/i.test(key);
}
