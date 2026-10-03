import { t, type TranslationKey } from '../i18n';

const ASPECT_RATIO_NAMES: Record<string, TranslationKey> = {
  auto: 'aspect.auto', adaptive: 'aspect.auto', '1:1': 'aspect.square', '16:9': 'aspect.horizontal', '9:16': 'aspect.vertical',
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

export function aspectRatioFrame(value: unknown) {
  const match = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(String(value));
  if (!match) return null;
  const width = Number(match[1]), height = Number(match[2]);
  if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) return null;
  // Equal area gives wide and tall outlines the same visual weight as a square.
  const longest = Math.max(width, height);
  const unitWidth = width / longest, unitHeight = height / longest;
  const scale = Math.min(22, 14 / Math.sqrt(unitWidth * unitHeight));
  // At 20 px, extreme ratios otherwise collapse to a line. Keep an open frame.
  const frameWidth = Math.max(6, unitWidth * scale), frameHeight = Math.max(6, unitHeight * scale);
  return { x: (24 - frameWidth) / 2, y: (24 - frameHeight) / 2, width: frameWidth, height: frameHeight };
}
