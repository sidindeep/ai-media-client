import { Component, createElement as h, createRef, type ReactNode, type RefAttributes } from 'react';
import { createRoot } from 'react-dom/client';
import { Player, type PlayerRef, type PlayerPropsWithoutZod } from '@remotion/player';
import { recordPreview } from './record-preview';
import { canRenderMediaOnWeb, renderMediaOnWeb } from '@remotion/web-renderer';
import { Movie, type MovieProps } from './composition';
import { FPS, timeline } from './model.mjs';
import { reportMovieError } from '../api/client';
import { checkMovieMedia } from './media-check.mjs';
import { exportFailure, MovieExportError, type ExportStage } from './export-error.mjs';
import { MovieMediaError } from './media-check.mjs';
import { prepareMovieMedia } from './prepare-media.mjs';
import { renderWithRecovery } from './render-recovery.mjs';
import limits from '../../../config/movie-editor.json' with { type: 'json' };
export { MovieExportError } from './export-error.mjs';
export { MovieMediaError } from './media-check.mjs';
export { reportMovieError } from '../api/client';

class PreviewBoundary extends Component<{ children?: ReactNode; onError: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onError(); reportMovieError('MOVIE_PREVIEW_FAILED'); }
  render() { return this.state.failed ? null : this.props.children; }
}
export function mountPreview(element: HTMLElement, onError: () => void = () => {}) {
  const root = createRoot(element);
  const ref = createRef<PlayerRef>();
  let currentProps: MovieProps | undefined;
  let revision = 0;
  return {
    update(props: MovieProps, width: number, height: number) {
      currentProps = props;
      root.render(h(PreviewBoundary, { key: ++revision, onError }, h<PlayerPropsWithoutZod<MovieProps> & RefAttributes<PlayerRef>>(Player, { ref, component: Movie, inputProps: props, durationInFrames: timeline(props.scenes).durationInFrames, fps: FPS, compositionWidth: width, compositionHeight: height, controls: true, style: { width: '100%', maxHeight: 480 }, acknowledgeRemotionLicense: true })));
    },
    record(signal: AbortSignal, onProgress: (progress: number) => void) {
      const frame = element.querySelector<HTMLElement>('#movie-composition');
      if (!ref.current || !frame || !currentProps) throw new Error('PREVIEW_RECORD_UNSUPPORTED');
      return recordPreview(ref.current, frame, timeline(currentProps.scenes).durationInFrames, FPS,
        Boolean(currentProps.music || (!currentProps.muteClips && currentProps.scenes.some(scene => scene.kind === 'video'))), signal, onProgress);
    },
    dispose() { root.unmount(); },
  };
}
export async function exportMovie(props: MovieProps, width: number, height: number, signal: AbortSignal, onProgress: (progress: number) => void,
  onPreparationProgress: (completed: number, total: number) => void = () => {}, onRecovery: () => void = () => {}) {
  let stage: ExportStage = 'support';
  let prepared: Awaited<ReturnType<typeof prepareMovieMedia>> | undefined;
  try {
    const durationInFrames = timeline(props.scenes).durationInFrames;
    const muted = !props.music && !props.scenes.some(scene => scene.kind === 'video' && !props.muteClips);
    const options = { width, height, container: 'mp4' as const, videoCodec: 'h264' as const, hardwareAcceleration: 'prefer-software' as const, muted };
    const support = await canRenderMediaOnWeb(options);
    if (!support.canRender) throw new Error('BROWSER_UNSUPPORTED');
    stage = 'media';
    prepared = await prepareMovieMedia(props, signal, onPreparationProgress);
    await checkMovieMedia(prepared.props, signal);
    stage = 'render';
    const localProps = prepared.props;
    const result = await renderWithRecovery(nativeVideo => renderMediaOnWeb({ ...options, keyframeIntervalInSeconds: 1, videoBitrate: 5_000_000, audioBitrate: 128_000, composition: { id: 'ai-media-movie', component: Movie, defaultProps: localProps, width, height, fps: FPS, durationInFrames }, inputProps: { ...localProps, nativeVideo }, signal, mediaCacheSizeInBytes: limits.mediaCacheBytes, delayRenderTimeoutInMilliseconds: limits.renderTimeoutMs, onProgress: ({ progress }) => onProgress(progress) }), signal, props.scenes.some(scene => scene.kind === 'video'), reason => ['render:TIMEOUT', 'render:DECODE'].includes(exportFailure(reason, 'render')), () => { onProgress(0); onRecovery(); });
    stage = 'output';
    return await result.getBlob();
  } catch (reason) {
    if (signal.aborted || reason instanceof MovieMediaError || (reason instanceof Error && reason.message === 'BROWSER_UNSUPPORTED')) throw reason;
    throw new MovieExportError(exportFailure(reason, stage));
  } finally { prepared?.dispose(); }
}
