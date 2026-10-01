import { ALL_FORMATS, BlobSource, Input, UrlSource } from 'mediabunny';
import { FPS, MAX_SECONDS } from './model.mjs';

export async function videoSeconds(source: string | Blob) {
  const input = new Input({ formats: ALL_FORMATS, source: typeof source === 'string'
    ? new UrlSource(source, { requestInit: { credentials: 'same-origin' }, getRetryDelay: () => null, maxCacheSize: 1024 * 1024 }) : new BlobSource(source) });
  const timeout = setTimeout(() => input.dispose(), 30000);
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('MOVIE_DURATION');
    const duration = await track.computeDuration();
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('MOVIE_DURATION');
    if (duration > MAX_SECONDS) throw new Error('MOVIE_VIDEO_TOO_LONG');
    return Math.max(1, Math.round(duration * FPS)) / FPS;
  } finally { clearTimeout(timeout); input.dispose(); }
}
