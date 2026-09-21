const ASPECT_RATIO_NAMES: Record<string, string> = {
  auto: 'Автоопределение',
  '1:1': 'Квадрат',
  '16:9': 'Горизонтальный',
  '9:16': 'Вертикальный',
  '4:3': 'Классический',
  '3:4': 'Портретный',
  '21:9': 'Кинематограф',
  '3:2': 'Альбомный',
  '2:3': 'Портретный',
  '4:5': 'Портретный',
  '5:4': 'Альбомный',
  '2:1': 'Широкий',
  '1:2': 'Вертикальный',
};

export function aspectRatioName(value: unknown) {
  return ASPECT_RATIO_NAMES[String(value).toLowerCase()] || '';
}

export function isAspectRatioField(key: string) {
  return /aspect.*ratio|ratio.*aspect/i.test(key);
}
