import { ALL_FORMATS, Input, UrlSource } from 'mediabunny';
import type { MovieProps } from './composition';

export class MovieMediaError extends Error {
  scene: number;
  kind: 'video' | 'audio';
  constructor(scene: number, kind: 'video' | 'audio') {
    super('MOVIE_MEDIA_UNSUPPORTED');
    this.scene = scene;
    this.kind = kind;
  }
}

type Track = { canDecode: () => Promise<boolean> };
type MediaInput = { getPrimaryVideoTrack: () => Promise<Track | null>; getPrimaryAudioTrack: () => Promise<Track | null>; dispose: () => void };
export async function checkMovieMedia(props: MovieProps, signal: AbortSignal,
  open: (src: string) => MediaInput = src => new Input({ formats: ALL_FORMATS,
    source: new UrlSource(src, { requestInit: { credentials: 'same-origin' }, getRetryDelay: () => null, maxCacheSize: 1024 * 1024 }) })) {
  const checked = new Set<string>();
  const sources = props.scenes.flatMap((scene, index) => scene.kind === 'video' ? [{ src: scene.src!, scene: index + 1, video: true,
    audio: !props.muteClips && props.scenes.some(item => item.src === scene.src && (item.volume ?? 1) > 0) }] : []);
  if (props.music && (props.musicSettings?.volume ?? 0.7) > 0) sources.push({ src: props.music, scene: 0, video: false, audio: true });
  for (const source of sources) {
    signal.throwIfAborted();
    if (checked.has(source.src)) continue;
    checked.add(source.src);
    const input = open(source.src);
    const abort = () => input.dispose();
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (source.video) {
        const track = await input.getPrimaryVideoTrack();
        if (!track || !await track.canDecode()) throw new MovieMediaError(source.scene, 'video');
      }
      if (source.audio) {
        const track = await input.getPrimaryAudioTrack();
        if ((!source.video && !track) || (track && !await track.canDecode())) throw new MovieMediaError(source.scene, 'audio');
      }
    } finally {
      signal.removeEventListener('abort', abort);
      input.dispose();
    }
    signal.throwIfAborted();
  }
}
