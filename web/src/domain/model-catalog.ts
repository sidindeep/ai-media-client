export type ModelPickerOption = {
  value: string;
  label: string;
  description?: string;
  groupId: string;
};

export type ModelBrand = {
  id: string;
  label: string;
  icon?: string;
  monochrome?: boolean;
  accent: string;
};

const ICON_ROOT = '/app/model-icons';

export const MODEL_BRANDS: ModelBrand[] = [
  { id: 'codex', label: 'Codex', icon: `${ICON_ROOT}/chatgpt.webp`, accent: '#8f75ff' },
  { id: 'kling', label: 'Kling', icon: `${ICON_ROOT}/kling.webp`, accent: '#32d6bc' },
  { id: 'seedance', label: 'Seedance', icon: `${ICON_ROOT}/seedance.webp`, accent: '#8f5cff' },
  { id: 'veo', label: 'Veo', icon: `${ICON_ROOT}/veo.webp`, accent: '#4f8cff' },
  { id: 'wan', label: 'Wan', icon: `${ICON_ROOT}/wan.webp`, accent: '#805cff' },
  { id: 'flux', label: 'FLUX', icon: `${ICON_ROOT}/flux.webp`, accent: '#c7c7d7' },
  { id: 'hailuo', label: 'Hailuo', icon: `${ICON_ROOT}/hailuo.webp`, accent: '#ff5f8a' },
  { id: 'grok', label: 'Grok', icon: `${ICON_ROOT}/grok-imagine.webp`, accent: '#d8d8df' },
  { id: 'minimax', label: 'MiniMax', icon: `${ICON_ROOT}/minimax.webp`, accent: '#ed4f9a' },
  { id: 'openai', label: 'OpenAI', icon: `${ICON_ROOT}/gpt-image.webp`, accent: '#57c9a8' },
  { id: 'google', label: 'Google', icon: `${ICON_ROOT}/nano-banana.webp`, accent: '#63a6ff' },
  { id: 'ideogram', label: 'Ideogram', icon: `${ICON_ROOT}/ideogram.webp`, accent: '#ee5da5' },
  { id: 'qwen', label: 'Qwen', icon: `${ICON_ROOT}/qwen-image.webp`, accent: '#7567ff' },
  { id: 'seedream', label: 'Seedream', icon: `${ICON_ROOT}/seedream.webp`, accent: '#9164ff' },
  { id: 'recraft', label: 'Recraft', icon: `${ICON_ROOT}/recraft.webp`, accent: '#ff6b43' },
  { id: 'topaz', label: 'Topaz', icon: `${ICON_ROOT}/topaz.webp`, accent: '#72a7ff' },
  { id: 'runway', label: 'Runway', icon: `${ICON_ROOT}/runway.webp`, accent: '#f1f1f4' },
  { id: 'pixverse', label: 'PixVerse', icon: `${ICON_ROOT}/pixverse.svg`, accent: '#8f67ff' },
  { id: 'happyhorse', label: 'HappyHorse', icon: `${ICON_ROOT}/happy-horse.webp`, accent: '#ffb24d' },
  { id: 'bytedance', label: 'ByteDance', icon: `${ICON_ROOT}/seedance.webp`, accent: '#5cc8ff' },
  { id: 'volcengine', label: 'Volcengine', icon: `${ICON_ROOT}/volcengine.svg`, accent: '#3377ff' },
  { id: 'elevenlabs', label: 'ElevenLabs', accent: '#f2f2f2' },
  { id: 'suno', label: 'Suno', accent: '#ff7a45' },
  { id: 'zimage', label: 'Z-Image', accent: '#9e83ff' },
  { id: 'other', label: 'Другие', accent: '#8f8aa3' },
];

const brandsById = new Map(MODEL_BRANDS.map(brand => [brand.id, brand]));

export function modelBrand(id: string) {
  return brandsById.get(id) || brandsById.get('other')!;
}

export function mediaModelBrandId(id: string, name: string) {
  const value = `${id} ${name}`.toLowerCase();
  if (value.includes('elevenlabs')) return 'elevenlabs';
  if (/suno|ai-music-api/.test(value)) return 'suno';
  if (value.includes('kling')) return 'kling';
  if (value.includes('seedance')) return 'seedance';
  if (/veo\s?3|veo3|gemini[ -]omni/.test(value)) return 'veo';
  if (/\bwan\b|[:/]wan(?:[/ -]|$)/.test(value)) return 'wan';
  if (value.includes('flux')) return 'flux';
  if (value.includes('hailuo')) return 'hailuo';
  if (value.includes('grok')) return 'grok';
  if (/minimax|omnihuman|infinitalk/.test(value)) return 'minimax';
  if (/gpt[ -]?image|gpt4o/.test(value)) return 'openai';
  if (/nano[ -]banana|google|imagen4/.test(value)) return 'google';
  if (value.includes('ideogram')) return 'ideogram';
  if (value.includes('qwen')) return 'qwen';
  if (value.includes('seedream')) return 'seedream';
  if (value.includes('recraft')) return 'recraft';
  if (value.includes('topaz')) return 'topaz';
  if (value.includes('runway')) return 'runway';
  if (value.includes('pixverse')) return 'pixverse';
  if (value.includes('happyhorse')) return 'happyhorse';
  if (value.includes('bytedance')) return 'bytedance';
  if (value.includes('volcengine')) return 'volcengine';
  if (value.includes('z-image')) return 'zimage';
  return 'other';
}

export function modelSummary(name: string, description?: string) {
  const normalized = name.toLowerCase();
  if (description && description !== name && description !== 'Отдельный API Kie.ai') return description;
  if (/remove background/.test(normalized)) return 'Удаление фона с изображения.';
  if (/upscale/.test(normalized)) return /video/.test(normalized) ? 'Увеличение разрешения видео.' : 'Увеличение разрешения изображения.';
  if (/segment map/.test(normalized)) return 'Создание карты сегментов изображения.';
  if (/segment edit|image edit|\bedit\b/.test(normalized)) return 'Редактирование и преобразование изображения.';
  if (/image to image|image-to-image/.test(normalized)) return 'Новая версия изображения по референсу.';
  if (/text to image|text-to-image/.test(normalized)) return 'Генерация изображения по текстовому описанию.';
  if (/reference to video|reference-to-video|references/.test(normalized)) return 'Видео по одному или нескольким референсам.';
  if (/first.*last|transition/.test(normalized)) return 'Видео между начальным и конечным кадрами.';
  if (/image to video|image-to-video/.test(normalized)) return 'Оживление изображения в видео.';
  if (/text to video|text-to-video/.test(normalized)) return 'Генерация видео по текстовому описанию.';
  if (/video edit|video-edit|video to video|video-to-video|transformation/.test(normalized)) return 'Преобразование готового видео.';
  if (/avatar|lip sync|from audio|speech to video/.test(normalized)) return 'Генерация говорящего персонажа с синхронизацией.';
  if (/motion.control|animate/.test(normalized)) return 'Перенос движения и анимация персонажа.';
  if (/extend/.test(normalized)) return 'Продление готового видео.';
  return 'Настраиваемая генерация через Kie.ai.';
}
