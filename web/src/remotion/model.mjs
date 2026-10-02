import limits from '../../../config/movie-editor.json' with { type: 'json' };
import { sceneEditing } from '../../../src/movie/editing.mjs';
export { sceneEditing, musicEditing, trimScene, splitScene } from '../../../src/movie/editing.mjs';
export const FPS = limits.fps;
export const MAX_SCENES = limits.maxScenes;
export const MAX_SECONDS = limits.maxSeconds;
export const MAX_STILL_SECONDS = limits.maxStillSeconds;
export const FORMATS = { landscape: [1280, 720], portrait: [720, 1280], square: [720, 720] };

export function timeline(scenes) {
  if (!Array.isArray(scenes) || !scenes.length || scenes.length > MAX_SCENES) throw new Error('SCENE_COUNT');
  let from = 0;
  const result = scenes.map(scene => {
    const seconds = Number(scene.seconds);
    if (!Number.isFinite(seconds) || seconds < (scene.kind === 'video' ? 1 / FPS : 1)
      || seconds > (scene.kind === 'video' ? MAX_SECONDS : MAX_STILL_SECONDS)) throw new Error('SCENE_DURATION');
    if (!['title', 'image', 'video'].includes(scene.kind)) throw new Error('SCENE_KIND');
    if (scene.kind !== 'title' && (!scene.src || !/^(blob:|data:image\/|\/api\/)/.test(scene.src))) throw new Error('SCENE_SOURCE');
    const durationInFrames = Math.round(seconds * FPS);
    const entry = { ...scene, ...sceneEditing(scene), from, durationInFrames, fadeIn: 0, fadeOut: 0, incomingTransition: 'cut' };
    from += durationInFrames;
    return entry;
  });
  let position = 0;
  for (let index = 0; index < result.length; index++) {
    const scene = result[index];
    scene.from = position;
    const next = result[index + 1];
    const overlap = next && scene.transition !== 'cut' ? Math.min(Math.round(scene.transitionSeconds * FPS), Math.floor(scene.durationInFrames / 2), Math.floor(next.durationInFrames / 2)) : 0;
    scene.fadeOut = overlap;
    if (next) { next.fadeIn = overlap; next.incomingTransition = scene.transition; }
    position += scene.durationInFrames - overlap;
  }
  if (position > FPS * MAX_SECONDS) throw new Error('TOTAL_DURATION');
  return { scenes: result, durationInFrames: position };
}
