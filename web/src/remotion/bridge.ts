import { Component, createElement as h, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Player, type PlayerPropsWithoutZod } from '@remotion/player';
import { canRenderMediaOnWeb, renderMediaOnWeb } from '@remotion/web-renderer';
import { Movie, type MovieProps } from './composition';
import { FPS, timeline } from './model.mjs';
import { reportMovieError } from '../api/client';
export { reportMovieError } from '../api/client';

class PreviewBoundary extends Component<{ children?: ReactNode; onError: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onError(); reportMovieError('MOVIE_PREVIEW_FAILED'); }
  render() { return this.state.failed ? null : this.props.children; }
}
export function mountPreview(element: HTMLElement, onError: () => void = () => {}) {
  const root = createRoot(element);
  let revision = 0;
  return {
    update(props: MovieProps, width: number, height: number) {
      root.render(h(PreviewBoundary, { key: ++revision, onError }, h<PlayerPropsWithoutZod<MovieProps>>(Player, { component: Movie, inputProps: props, durationInFrames: timeline(props.scenes).durationInFrames, fps: FPS, compositionWidth: width, compositionHeight: height, controls: true, style: { width: '100%', maxHeight: 480 }, acknowledgeRemotionLicense: true })));
    },
    dispose() { root.unmount(); },
  };
}
export async function exportMovie(props: MovieProps, width: number, height: number, signal: AbortSignal, onProgress: (progress: number) => void) {
  const muted = !props.music && !props.scenes.some(scene => scene.kind === 'video' && !props.muteClips);
  const options = { width, height, container: 'mp4' as const, videoCodec: 'h264' as const, muted };
  const support = await canRenderMediaOnWeb(options);
  if (!support.canRender) throw new Error('BROWSER_UNSUPPORTED');
  const result = await renderMediaOnWeb({ ...options, composition: { id: 'ai-media-movie', component: Movie, defaultProps: props, width, height, fps: FPS, durationInFrames: timeline(props.scenes).durationInFrames }, inputProps: props, signal, mediaCacheSizeInBytes: 128 * 1024 * 1024, onProgress: ({ progress }) => onProgress(progress) });
  return result.getBlob();
}
