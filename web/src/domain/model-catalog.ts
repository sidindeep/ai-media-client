import { t } from '../i18n';

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
  { id: 'routerai', label: 'RouterAI', accent: '#67b7ff' },
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
  { id: 'other', label: 'Other', accent: '#8f8aa3' },
];

const brandsById = new Map(MODEL_BRANDS.map(brand => [brand.id, brand]));

export function modelBrand(id: string): ModelBrand {
  if (id.startsWith('routerai:')) {
    const slug = id.slice('routerai:'.length);
    const label = slug.split('-').map(part => part ? part[0].toUpperCase() + part.slice(1) : '').join(' ');
    return { id, label, accent: '#67b7ff' };
  }
  const brand = brandsById.get(id) || brandsById.get('other')!;
  return brand.id === 'other' ? { ...brand, label: t('model.other') } : brand;
}

export function routerAiModelBrandId(id: string) {
  const vendor = id.replace(/^~/, '').split('/')[0]?.toLowerCase() || 'other';
  const known: Record<string, string> = {
    'black-forest-labs': 'flux', 'bytedance-seed': 'seedream', 'x-ai': 'grok',
    'openai': 'openai', 'google': 'google', 'qwen': 'qwen', 'recraft': 'recraft',
    'runway': 'runway', 'ideogram': 'ideogram', 'minimax': 'minimax',
    'alibaba': 'wan', 'elevenlabs': 'elevenlabs', 'suno': 'suno',
  };
  return known[vendor] || `routerai:${vendor}`;
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
  if (/remove background/.test(normalized)) return t('model.summary.removeBackground');
  if (/upscale/.test(normalized)) return t(/video/.test(normalized) ? 'model.summary.upscaleVideo' : 'model.summary.upscaleImage');
  if (/segment map/.test(normalized)) return t('model.summary.segmentMap');
  if (/segment edit|image edit|\bedit\b/.test(normalized)) return t('model.summary.editImage');
  if (/image to image|image-to-image/.test(normalized)) return t('model.summary.imageToImage');
  if (/text to image|text-to-image/.test(normalized)) return t('model.summary.textToImage');
  if (/reference to video|reference-to-video|references/.test(normalized)) return t('model.summary.referenceToVideo');
  if (/first.*last|transition/.test(normalized)) return t('model.summary.transition');
  if (/image to video|image-to-video/.test(normalized)) return t('model.summary.imageToVideo');
  if (/text to video|text-to-video/.test(normalized)) return t('model.summary.textToVideo');
  if (/video edit|video-edit|video to video|video-to-video|transformation/.test(normalized)) return t('model.summary.videoEdit');
  if (/avatar|lip sync|from audio|speech to video/.test(normalized)) return t('model.summary.avatar');
  if (/motion.control|animate/.test(normalized)) return t('model.summary.animate');
  if (/extend/.test(normalized)) return t('model.summary.extend');
  return t('model.summary.default');
}
