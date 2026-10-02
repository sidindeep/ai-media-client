import limits from '../../config/movie-editor.json' with { type: 'json' };
const settings = limits.editing;
const number = (value, fallback, min, max) => {
  const result = value === undefined ? fallback : value;
  if (!Number.isFinite(result) || result < min || result > max) throw new Error('MOVIE_EDIT_VALUE');
  return result;
};
const choice = (value, fallback, choices) => {
  const result = value === undefined ? fallback : value;
  if (!choices.includes(result)) throw new Error('MOVIE_EDIT_VALUE');
  return result;
};
const color = (value, fallback) => {
  const result = value === undefined ? fallback : value;
  if (typeof result !== 'string' || !/^#[a-f0-9]{6}$/i.test(result)) throw new Error('MOVIE_EDIT_VALUE');
  return result;
};
export function sceneEditing(scene) {
  if (!Number.isFinite(scene.seconds) || scene.seconds <= 0) throw new Error('MOVIE_EDIT_VALUE');
  const result = {
    trimStart: number(scene.trimStart, 0, 0, limits.maxSeconds),
    fit: choice(scene.fit, 'contain', ['contain', 'cover']),
    scale: number(scene.scale, 1, 1, settings.maxScale),
    offsetX: number(scene.offsetX, 0, -settings.maxOffset, settings.maxOffset),
    offsetY: number(scene.offsetY, 0, -settings.maxOffset, settings.maxOffset),
    motion: choice(scene.motion, 'none', ['none', 'zoom-in', 'zoom-out']),
    transition: choice(scene.transition, 'fade', ['cut', 'fade', 'slide']),
    transitionSeconds: number(scene.transitionSeconds, limits.transitionFrames / limits.fps, 0, settings.maxTransitionSeconds),
    volume: number(scene.volume, 1, 0, 1),
    audioFadeIn: number(scene.audioFadeIn, 0, 0, settings.maxFadeSeconds),
    audioFadeOut: number(scene.audioFadeOut, 0, 0, settings.maxFadeSeconds),
    captionStart: number(scene.captionStart, 0, 0, scene.seconds),
    captionEnd: number(scene.captionEnd, scene.seconds, 0, scene.seconds),
    captionSize: number(scene.captionSize, settings.captionSize, settings.minCaptionSize, settings.maxCaptionSize),
    captionColor: color(scene.captionColor, '#ffffff'),
    captionBackground: color(scene.captionBackground, '#10121d'),
    captionPosition: choice(scene.captionPosition, scene.kind === 'title' ? 'center' : 'bottom', ['top', 'center', 'bottom']),
  };
  if (result.captionEnd < result.captionStart) throw new Error('MOVIE_EDIT_VALUE');
  if (scene.sourceDuration !== undefined) {
    result.sourceDuration = number(scene.sourceDuration, 0, 1 / limits.fps, limits.maxSeconds);
    if (scene.kind === 'video' && result.trimStart + scene.seconds > result.sourceDuration + 1 / limits.fps) throw new Error('MOVIE_TRIM_RANGE');
  }
  if (result.trimStart + scene.seconds > limits.maxSeconds + 1 / limits.fps) throw new Error('MOVIE_TRIM_RANGE');
  return result;
}
export function musicEditing(value = {}) {
  const result = {
    volume: number(value.volume, settings.musicVolume, 0, 1),
    start: number(value.start, 0, 0, limits.maxSeconds),
    trimStart: number(value.trimStart, 0, 0, limits.maxSeconds),
    fadeIn: number(value.fadeIn, 0, 0, settings.maxFadeSeconds),
    fadeOut: number(value.fadeOut, 0, 0, settings.maxFadeSeconds),
  };
  if (value.sourceDuration !== undefined) {
    result.sourceDuration = number(value.sourceDuration, 0, 1 / limits.fps, limits.maxSeconds);
    if (result.trimStart >= result.sourceDuration) throw new Error('MOVIE_TRIM_RANGE');
  }
  return result;
}
// Editing operations preserve source references and clamp caption windows to
// the selected content. Split does not insert an overlapping transition.
export function trimScene(scene, start, end) {
  const trimmed = { ...scene, trimStart: start, seconds: Math.round((end - start) * limits.fps) / limits.fps };
  if (trimmed.seconds < 1 / limits.fps) throw new Error('MOVIE_TRIM_RANGE');
  trimmed.captionStart = Math.min(scene.captionStart ?? 0, trimmed.seconds);
  trimmed.captionEnd = Math.min(scene.captionEnd ?? trimmed.seconds, trimmed.seconds);
  sceneEditing(trimmed);
  return trimmed;
}
export function splitScene(scene, atSeconds, id) {
  const cut = Math.round(atSeconds * limits.fps) / limits.fps;
  if (scene.kind !== 'video' || !Number.isFinite(cut) || cut < 1 / limits.fps || cut > scene.seconds - 1 / limits.fps) throw new Error('MOVIE_SPLIT_RANGE');
  const editing = sceneEditing(scene);
  const left = { ...scene, ...editing, seconds: cut, transition: 'cut', audioFadeOut: 0,
    captionStart: Math.min(editing.captionStart, cut), captionEnd: Math.min(editing.captionEnd, cut) };
  const right = { ...scene, ...editing, id, seconds: scene.seconds - cut, trimStart: editing.trimStart + cut, audioFadeIn: 0,
    captionStart: Math.max(0, editing.captionStart - cut), captionEnd: Math.max(0, editing.captionEnd - cut) };
  return [left, right];
}
