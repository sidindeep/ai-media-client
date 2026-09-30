const { isDeepStrictEqual } = require('node:util');

// The task vocabulary describes user intent, never another provider's payload.
const aliases = {
  size: 'aspect_ratio', ratio: 'aspect_ratio', aspectRatio: 'aspect_ratio',
  image_size: 'resolution', image_input: 'source_images', input_urls: 'source_images',
  image_url: 'source_images', image_urls: 'source_images', inputImage: 'source_images',
  imageUrls: 'reference_images', image_references: 'reference_images', reference_image_urls: 'reference_images',
  reference_image: 'reference_images', firstFrame: 'first_frame', lastFrame: 'last_frame',
  first_frame_url: 'first_frame', first_frame_image: 'first_frame', first_frame_image_url: 'first_frame',
  last_frame_url: 'last_frame', last_frame_image: 'last_frame', last_frame_image_url: 'last_frame',
  video_urls: 'reference_videos', reference_video_urls: 'reference_videos', video_url: 'source_videos',
  extend_from_task_id: 'source_task_id', img_references: 'reference_images',
  audio_urls: 'reference_audio', reference_audio_urls: 'reference_audio',
  audio: 'generate_audio', sound: 'generate_audio', generate_audio_switch: 'generate_audio',
  fixed_lens: 'camera_fixed', camerafixed: 'camera_fixed', n: 'count',
  customize_multi_shots: 'multi_shot', elements: 'element_list',
};
function semanticKey(key) {
  return Object.hasOwn(aliases, key) ? aliases[key] : key;
}
function contentRefs(value) {
  if (typeof value === 'string') return /^content:[a-f0-9-]{36}$/.test(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(contentRefs);
  return value && typeof value === 'object' ? Object.values(value).flatMap(contentRefs) : [];
}
function rawTask(raw, keyOf = semanticKey) {
  const parameters = {};
  for (const [key, value] of Object.entries(raw.input)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key))
      throw Object.assign(new Error('Некорректное имя параметра задачи'), { status: 400 });
    if (key === 'prompt' || value == null || Array.isArray(value) && !value.length) continue;
    const semantic = keyOf(key, raw.modelId);
    if (Object.hasOwn(parameters, semantic) && !isDeepStrictEqual(parameters[semantic], value))
      throw new Error(`Конфликт параметров задачи: ${semantic}`);
    parameters[semantic] = structuredClone(value);
  }
  return { prompt: raw.input.prompt || '', parameters, sourceFiles: structuredClone(raw.sourceFiles || []),
    // Native input remains available for the existing manual provider contract.
    origin: { modelId: raw.modelId, input: structuredClone(raw.input) }, action: raw.action || 'auto' };
}
module.exports = { rawTask, semanticKey, contentRefs };
