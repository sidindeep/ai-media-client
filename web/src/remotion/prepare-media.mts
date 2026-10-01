import type { MovieProps } from './composition';
import limits from '../../../config/movie-editor.json' with { type: 'json' };

const MAX_FILE_BYTES = limits.maxFileBytes;
// Render from complete local files so per-frame decoding never waits on the
// account API or object storage. Draft references remain untouched.
export async function prepareMovieMedia(props: MovieProps, signal: AbortSignal,
  onProgress: (completed: number, total: number) => void = () => {}, fetcher: typeof fetch = fetch) {
  const sources = [...new Set([...props.scenes.flatMap(scene => scene.src ? [scene.src] : []), ...(props.music ? [props.music] : [])])];
  const local = new Map<string, string>();
  const dispose = () => { for (const url of local.values()) URL.revokeObjectURL(url); local.clear(); };
  try {
    onProgress(0, sources.length);
    for (const src of sources) {
      signal.throwIfAborted();
      if (!src.startsWith('/api/') && !src.startsWith('blob:') && !src.startsWith('data:image/')) throw new Error('SCENE_SOURCE');
      const request = new AbortController();
      const abort = () => request.abort(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => request.abort(new DOMException('Source download timed out', 'TimeoutError')), limits.sourceTimeoutMs);
      try {
        const response = await fetcher(src, { credentials: 'same-origin', signal: request.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (Number(response.headers.get('content-length')) > MAX_FILE_BYTES) {
          await response.body?.cancel();
          throw new Error('MOVIE_FILE_TOO_LARGE');
        }
        const blob = await response.blob();
        if (blob.size > MAX_FILE_BYTES) throw new Error('MOVIE_FILE_TOO_LARGE');
        signal.throwIfAborted();
        local.set(src, URL.createObjectURL(blob));
        onProgress(local.size, sources.length);
      } catch (reason) { if (request.signal.aborted) throw request.signal.reason; throw reason; }
      finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
    }
    return { props: { ...props, scenes: props.scenes.map(scene => ({ ...scene, ...(scene.src ? { src: local.get(scene.src)! } : {}) })),
      music: props.music ? local.get(props.music)! : undefined }, dispose };
  } catch (reason) { dispose(); throw reason; }
}
