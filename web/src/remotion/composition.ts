import { createElement as h } from 'react';
import { AbsoluteFill, Html5Audio, Html5Video, Img, Sequence, interpolate, useCurrentFrame, useRemotionEnvironment } from 'remotion';
import { Audio, Video } from '@remotion/media';
import { FPS, timeline, musicEditing, type TimelineScene, type MusicEditing } from './model.mjs';
import { NativeVideo } from './native-video';
import limits from '../../../config/movie-editor.json' with { type: 'json' };

export type MovieProps = { scenes: import('./model.mjs').Scene[]; music?: string; musicSettings?: MusicEditing; background: string; muteClips: boolean; nativeVideo?: boolean };
const ramp = (frame: number, frames: number) => frames > 0 ? Math.max(0, Math.min(1, frame / frames)) : 1;
function Shot({ scene, background, muteClips, nativeVideo }: { scene: TimelineScene; background: string; muteClips: boolean; nativeVideo?: boolean }) {
  const frame = useCurrentFrame();
  const { isPlayer } = useRemotionEnvironment();
  const entrance = ramp(frame, scene.fadeIn);
  const opacity = scene.incomingTransition === 'fade' ? entrance : 1;
  const volume = scene.volume * ramp(frame, Math.max(scene.fadeIn, scene.audioFadeIn * FPS))
    * ramp(scene.durationInFrames - frame - 1, Math.max(scene.fadeOut, scene.audioFadeOut * FPS));
  const motion = scene.kind === 'image' && scene.motion !== 'none'
    ? interpolate(frame, [0, Math.max(1, scene.durationInFrames - 1)], scene.motion === 'zoom-in' ? [1, limits.editing.photoZoom] : [limits.editing.photoZoom, 1]) : 1;
  const style = { width: '100%', height: '100%', objectFit: scene.fit };
  const trimBefore = Math.round(scene.trimStart * FPS);
  const captionVisible = frame >= Math.round(scene.captionStart * FPS) && frame < Math.round(scene.captionEnd * FPS);
  return h(AbsoluteFill, { style: { backgroundColor: background, opacity, overflow: 'hidden', transform: scene.incomingTransition === 'slide' ? `translateX(${(1 - entrance) * 100}%)` : undefined } },
    h(AbsoluteFill, { style: { transform: `translate(${scene.offsetX}%, ${scene.offsetY}%) scale(${scene.scale * motion})` } },
    scene.kind === 'image' ? h(Img, { src: scene.src!, style }) : null,
    scene.kind === 'video' ? (isPlayer ? h(Html5Video, { src: scene.src!, style, trimBefore, muted: muteClips || scene.volume === 0, volume }) : nativeVideo
      ? h(NativeVideo, { src: scene.src!, trimStart: scene.trimStart, fit: scene.fit }) : h(Video, { src: scene.src!, style, trimBefore, muted: muteClips || scene.volume === 0, volume })) : null),
    scene.kind === 'video' && !isPlayer && nativeVideo && !muteClips && scene.volume > 0 ? h(Audio, { src: scene.src!, trimBefore, volume }) : null,
    scene.title && captionVisible ? h(AbsoluteFill, { style: { justifyContent: scene.captionPosition === 'center' ? 'center' : scene.captionPosition === 'top' ? 'flex-start' : 'flex-end', alignItems: 'center', padding: 48, paddingBottom: 64 } },
      h('div', { style: { color: scene.captionColor, backgroundColor: `${scene.captionBackground}cc`, padding: '24px 32px', borderRadius: 16, fontSize: scene.captionSize, fontFamily: 'Arial, sans-serif', fontWeight: 700, textAlign: 'center', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxWidth: '100%' } }, scene.title)) : null);
}
function Music({ src, settings, duration }: { src: string; settings: MusicEditing; duration: number }) {
  const frame = useCurrentFrame();
  const { isPlayer } = useRemotionEnvironment();
  const volume = settings.volume * ramp(frame, settings.fadeIn * FPS) * ramp(duration - frame - 1, settings.fadeOut * FPS);
  return isPlayer ? h(Html5Audio, { src, trimBefore: Math.round(settings.trimStart * FPS), volume }) : h(Audio, { src, trimBefore: Math.round(settings.trimStart * FPS), volume });
}
export function Movie(props: MovieProps) {
  const plan = timeline(props.scenes);
  const settings = musicEditing(props.musicSettings);
  const musicFrom = Math.round(settings.start * FPS);
  const musicDuration = Math.min(plan.durationInFrames - musicFrom, settings.sourceDuration === undefined ? Infinity : Math.round((settings.sourceDuration - settings.trimStart) * FPS));
  return h(AbsoluteFill, { id: 'movie-composition', style: { backgroundColor: props.background } },
    ...plan.scenes.map(scene => h(Sequence, { key: scene.id, from: scene.from, durationInFrames: scene.durationInFrames }, h(Shot, { scene, background: props.background, muteClips: props.muteClips, nativeVideo: props.nativeVideo }))),
    props.music && settings.volume > 0 && musicDuration > 0 ? h(Sequence, { from: musicFrom, durationInFrames: musicDuration }, h(Music, { src: props.music, settings, duration: musicDuration })) : null);
}
