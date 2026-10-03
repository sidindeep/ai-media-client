const schemas = require('../../../config/apimart-schemas.json').models;

const aliases = {
  'gpt-image-1': 'gpt-image-1-official', 'gpt-image-1.5': 'gpt-image-1.5-official',
  'seedance-2.0-face': 'seedance-2.0', 'seedance-2.0-fast-face': 'seedance-2.0-fast',
  'grok-imagine-1.0-apimart': 'grok-imagine-1.5-apimart',
  'grok-imagine-1.0-edit-apimart': 'grok-imagine-1.5-apimart',
  'grok-imagine-1.5-edit-apimart': 'grok-imagine-1.5-apimart',
  'grok-imagine-image': 'grok-imagine-1.5-apimart', 'grok-imagine-image-quality': 'grok-imagine-1.5-apimart',
  'grok-imagine-1.0-video-apimart': 'grok-imagine-1.5-video-ext',
  'grok-imagine-1.5-video-apimart': 'grok-imagine-1.5-video-ext',
  'Omni-Flash-Ext': 'gemini-omni-1.1-flash-ext', 'wan2.6-i2v': 'wan2.6',
};
const KINDS = { chat: 'text', image: 'image', video: 'video', audio: 'audio' };
const LEGACY_COMPLETIONS = new Set(['babbage-002', 'davinci-002', 'text-ada-001', 'text-babbage-001', 'text-curie-001']);
const SPEECH_MODELS = new Set(['tts-1', 'tts-1-1106', 'tts-1-hd', 'tts-1-hd-1106', 'gpt-4o-mini-tts']);
const MUSIC_MODELS = new Set(['suno', 'flowmusic']);
const MODEL_ID = /^[a-z0-9][a-z0-9._:/-]{0,159}$/i;
const fieldPresentation = {
  'kling-v2-6-motion-control': { mode: { label: 'Качество', default: 'std',
    optionLabels: { std: '720p', pro: '1080p' } } },
  'kling-v3-motion-control': { mode: { label: 'Качество', default: 'std',
    optionLabels: { std: '720p', pro: '1080p' } } },
};
const voiceField = { key: 'voice', label: 'Голос', type: 'string',
  options: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'], hint: 'По умолчанию: alloy' };
function describeModel(item) {
  if (typeof item?.id !== 'string' || !MODEL_ID.test(item.id)) return null;
  const kind = KINDS[item.category] || 'text';
  const metadata = schemas[item.id] || schemas[aliases[item.id]];
  let endpoint = kind === 'text' ? '/v1/chat/completions' : kind === 'image' ? '/v1/images/generations'
    : kind === 'video' ? '/v1/videos/generations' : '/v1/music/generations';
  let fields = metadata?.fields || [];
  const presentation = fieldPresentation[item.id];
  if (presentation) fields = fields.map(field => ({ ...field, ...(presentation[field.key] || {}) }));
  let promptRequired = metadata?.promptRequired ?? true;
  if (metadata) endpoint = metadata.endpoint;
  if (item.id === 'dall-e-3') fields = [
    { key: 'size', label: 'Размер', type: 'string', options: ['1024x1024', '1792x1024', '1024x1792'] },
    { key: 'quality', label: 'Качество', type: 'string', options: ['standard', 'hd'] },
    { key: 'style', label: 'Стиль', type: 'string', options: ['vivid', 'natural'] },
  ];
  if (kind === 'text') {
    if (item.supported_endpoint_types?.includes('openai-response') && !item.supported_endpoint_types?.includes('openai')) endpoint = '/v1/responses';
    if (LEGACY_COMPLETIONS.has(item.id)) endpoint = '/v1/completions';
    if (item.id === 'text-davinci-edit-001') endpoint = '/v1/edits';
  }
  if (kind === 'audio' && !MUSIC_MODELS.has(item.id)) {
    if (item.id === 'whisper-1') {
      endpoint = '/v1/audio/transcriptions'; promptRequired = false;
      fields = [{ key: 'audio_file', label: 'Аудиофайл', type: 'files', required: true, scalar: true,
        maxFiles: 1, maxSizeMb: 25, accept: 'audio/*' }, { key: 'language', label: 'Язык (ru, en, …)', type: 'string' }];
    } else {
      endpoint = SPEECH_MODELS.has(item.id) ? '/v1/audio/speech' : '/v1/chat/completions';
      fields = [voiceField];
    }
  }
  // These variants explicitly require a reference input.
  if (item.id.includes('-edit-apimart') || item.id === 'wan2.6-i2v') fields = fields.map(field => field.key === 'image_urls' ? { ...field, required: true } : field);
  return require('../../model-ui-visibility').applyModelUiVisibility({ id: item.id, name: item.id, kind, endpoint, fields, promptRequired,
    ...(metadata?.taskActions ? { taskActions: metadata.taskActions } : {}),
    ...(metadata?.durationMode ? { durationMode: metadata.durationMode } : {}),
    capabilities: Array.isArray(item.capability_tags) ? item.capability_tags.filter(value => typeof value === 'string') : [],
    ...(metadata?.source ? { documentation: metadata.source } : {}) }, 'apimart');
}
module.exports = { describeModel, SPEECH_MODELS, MUSIC_MODELS, MODEL_ID };
