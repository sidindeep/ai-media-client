import { createElement as h } from 'react';
import { AbsoluteFill, Img, Sequence, interpolate, useCurrentFrame } from 'remotion';
import { Audio, Video } from '@remotion/media';
import { timeline, type Scene } from './model.mjs';

export type MovieProps = { scenes: Scene[]; music?: string; background: string; muteClips: boolean };
function Shot({ scene, background, muteClips }: { scene: Scene & { durationInFrames: number }; background: string; muteClips: boolean }) {
  const frame = useCurrentFrame();
  const fade = Math.min(10, scene.durationInFrames / 4);
  const opacity = interpolate(frame, [0, fade, scene.durationInFrames - fade, scene.durationInFrames], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const style = { width: '100%', height: '100%', objectFit: 'contain' as const };
  return h(AbsoluteFill, { style: { backgroundColor: background, opacity } },
    scene.kind === 'image' ? h(Img, { src: scene.src!, style }) : null,
    scene.kind === 'video' ? h(Video, { src: scene.src!, style, muted: muteClips }) : null,
    scene.title ? h(AbsoluteFill, { style: { justifyContent: scene.kind === 'title' ? 'center' : 'flex-end', alignItems: 'center', padding: 48, paddingBottom: 64 } },
      h('div', { style: { color: '#ffffff', backgroundColor: '#10121dcc', padding: '24px 32px', borderRadius: 16, fontSize: 48, fontFamily: 'Arial, sans-serif', fontWeight: 700, textAlign: 'center', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxWidth: '100%' } }, scene.title)) : null);
}
export function Movie(props: MovieProps) {
  const plan = timeline(props.scenes);
  return h(AbsoluteFill, { style: { backgroundColor: props.background } },
    ...plan.scenes.map(scene => h(Sequence, { key: scene.id, from: scene.from, durationInFrames: scene.durationInFrames }, h(Shot, { scene, background: props.background, muteClips: props.muteClips }))),
    props.music ? h(Audio, { src: props.music, volume: 0.7 }) : null);
}
