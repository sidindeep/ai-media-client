export const FPS = 30;
export const MAX_SCENES = 20;
export const MAX_SECONDS = 120;
export const FORMATS = { landscape: [1280, 720], portrait: [720, 1280], square: [720, 720] };

export function timeline(scenes) {
  if (!Array.isArray(scenes) || !scenes.length || scenes.length > MAX_SCENES) throw new Error('SCENE_COUNT');
  let from = 0;
  const result = scenes.map(scene => {
    const seconds = Number(scene.seconds);
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 30) throw new Error('SCENE_DURATION');
    if (!['title', 'image', 'video'].includes(scene.kind)) throw new Error('SCENE_KIND');
    if (scene.kind !== 'title' && (!scene.src || !/^(blob:|data:image\/|\/api\/)/.test(scene.src))) throw new Error('SCENE_SOURCE');
    const durationInFrames = Math.round(seconds * FPS);
    const entry = { ...scene, from, durationInFrames };
    from += durationInFrames;
    return entry;
  });
  if (from > FPS * MAX_SECONDS) throw new Error('TOTAL_DURATION');
  return { scenes: result, durationInFrames: from };
}
