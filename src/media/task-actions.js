const actions = new Set(['auto', 'text-to-image', 'image-to-image', 'text-to-video', 'image-to-video',
  'reference-to-video', 'first-last-frame-to-video', 'video-extension', 'layer-decomposition',
  'video-edit', 'motion-control', 'image-upscale', 'video-upscale', 'remove-background']);

// Used only when importing old documents; the registry stores the explicit action.
function inferAction(row) {
  const id = (row.providers?.kie || row.id || '').toLowerCase().replace(/_/g, '-');
  if (id.includes('layer-decomposition')) return 'layer-decomposition';
  if (/first-and-last-frames|first-last-frame|[/.]transition$/.test(id)) return 'first-last-frame-to-video';
  if (/reference(?:-to|-2)-video/.test(id)) return 'reference-to-video';
  if (id.includes('motion-control')) return 'motion-control';
  if (id.includes('text-to-image')) return 'text-to-image';
  if (/text(?:-to|-2)-video/.test(id)) return 'text-to-video';
  if (id.includes('image-to-video')) return 'image-to-video';
  if (row.kind === 'image' && /image-to-image|(?:[/. -]|-)edit(?:-|$)|remix|reframe/.test(id)) return 'image-to-image';
  if (row.kind === 'video' && /video-edit|[/.]modify$|reframe|transformation/.test(id)) return 'video-edit';
  if (row.kind === 'video' && /[/.]extend$/.test(id)) return 'video-extension';
  if (id.includes('upscale')) return row.kind === 'video' ? 'video-upscale' : row.kind === 'image' ? 'image-upscale' : 'auto';
  if (id.includes('remove-background')) return 'remove-background';
  return 'auto';
}
function validateTaskAction(task) {
  const action = task.action || 'auto';
  if (!actions.has(action)) throw new Error('Неизвестный режим задачи');
  const p = task.parameters;
  const present = key => p[key] != null && p[key] !== '' && (!Array.isArray(p[key]) || p[key].length > 0);
  const image = ['source_images', 'reference_images', 'first_frame', 'last_frame', 'image_with_roles'].some(present);
  const video = ['source_videos', 'reference_videos'].some(present);
  const sourceTask = ['source_task_id', 'task_id'].some(present);
  if (['text-to-image', 'text-to-video'].includes(action) && (image || video || sourceTask || p.layer_decomposition === true))
    throw new Error('Режим генерации по тексту несовместим с исходниками или режимом редактирования');
  if (['image-to-image', 'image-to-video', 'layer-decomposition', 'image-upscale', 'remove-background'].includes(action) && !image)
    throw new Error('Для выбранного режима нужен исходник изображения');
  if (action === 'reference-to-video' && !['reference_images', 'reference_videos', 'reference_audio', 'image_with_roles'].some(present))
    throw new Error('Для генерации по референсам нужен исходник');
  if (action === 'reference-to-video' && ['source_images', 'first_frame', 'last_frame', 'source_task_id'].some(present))
    throw new Error('Режим референсов несовместим с режимом кадров или продолжения');
  if (action === 'image-to-video' && ['reference_images', 'reference_videos', 'source_task_id'].some(present))
    throw new Error('Режим изображения несовместим с референсами или продолжением');
  if (action === 'first-last-frame-to-video' && !present('first_frame'))
    throw new Error('Для режима кадров нужен начальный кадр');
  if (action === 'first-last-frame-to-video' && ['source_images', 'reference_images', 'reference_videos', 'source_task_id'].some(present))
    throw new Error('Режим кадров несовместим с референсами или продолжением');
  if (['video-extension', 'video-edit', 'video-upscale'].includes(action) && !video && !sourceTask)
    throw new Error('Для выбранного режима нужен исходник видео или задача провайдера');
  if (action === 'motion-control' && (!image || !video))
    throw new Error('Для управления движением нужны изображение и видео');
  if (action === 'layer-decomposition' && p.layer_decomposition === false)
    throw new Error('Режим разложения на слои нельзя отключить в выбранной модели');
  if (action !== 'auto' && action !== 'layer-decomposition' && p.layer_decomposition === true)
    throw new Error('Выбранный режим несовместим с разложением на слои');
}
module.exports = { actions, inferAction, validateTaskAction };
