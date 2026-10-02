import { createElement as h } from 'react';
import { AbsoluteFill, Html5Audio, Html5Video, Img, Sequence, interpolate, useCurrentFrame, useRemotionEnvironment } from 'remotion';
import { Audio, Video } from '@remotion/media';
import { timeline, type Scene } from './model.mjs';
import { NativeVideo } from './native-video';

export type MovieProps = { scenes: Scene[]; music?: string; background: string; muteClips: boolean; nativeVideo?: boolean };
function Shot({ scene, background, muteClips, nativeVideo }: { scene: Scene & { durationInFrames: number; fadeIn: number; fadeOut: number }; background: string; muteClips: boolean; nativeVideo?: boolean }) {
  const frame = useCurrentFrame();
  const { isPlayer } = useRemotionEnvironment();
  const opacity = scene.fadeIn ? interpolate(frame, [0, scene.fadeIn], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) : 1;
  const volume = (f: number) => (scene.fadeIn ? interpolate(f, [0, scene.fadeIn], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) : 1)
    * (scene.fadeOut ? interpolate(f, [scene.durationInFrames - scene.fadeOut, scene.durationInFrames], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) : 1);
  const style = { width: '100%', height: '100%', objectFit: 'contain' as const };
  return h(AbsoluteFill, { style: { backgroundColor: background, opacity } },
    scene.kind === 'image' ? h(Img, { src: scene.src!, style }) : null,
    scene.kind === 'video' ? (isPlayer ? h(Html5Video, { src: scene.src!, style, muted: muteClips, volume }) : nativeVideo
      ? h(NativeVideo, { src: scene.src! }) : h(Video, { src: scene.src!, style, muted: muteClips, volume })) : null,
    scene.kind === 'video' && !isPlayer && nativeVideo && !muteClips ? h(Audio, { src: scene.src!, volume }) : null,
    scene.title ? h(AbsoluteFill, { style: { justifyContent: scene.kind === 'title' ? 'center' : 'flex-end', alignItems: 'center', padding: 48, paddingBottom: 64 } },
      h('div', { style: { color: '#ffffff', backgroundColor: '#10121dcc', padding: '24px 32px', borderRadius: 16, fontSize: 48, fontFamily: 'Arial, sans-serif', fontWeight: 700, textAlign: 'center', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxWidth: '100%' } }, scene.title)) : null);
}
export function Movie(props: MovieProps) {
  const { isPlayer } = useRemotionEnvironment();
  const plan = timeline(props.scenes);
  return h(AbsoluteFill, { id: 'movie-composition', style: { backgroundColor: props.background } },
    ...plan.scenes.map(scene => h(Sequence, { key: scene.id, from: scene.from, durationInFrames: scene.durationInFrames }, h(Shot, { scene, background: props.background, muteClips: props.muteClips, nativeVideo: props.nativeVideo }))),
    props.music ? (isPlayer ? h(Html5Audio, { src: props.music, volume: 0.7 }) : h(Audio, { src: props.music, volume: 0.7 })) : null);
}
