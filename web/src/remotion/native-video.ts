import { createElement as h, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useCurrentFrame, useDelayRender, useVideoConfig } from 'remotion';
import limits from '../../../config/movie-editor.json' with { type: 'json' };

// The recovery path uses the same native decoder as Player. Only the canvas
// enters the renderer; audio is still assembled separately at exact timestamps.
export function NativeVideo({ src }: { src: string }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { delayRender, continueRender, cancelRender } = useDelayRender();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [video] = useState(() => {
    const element = document.createElement('video');
    element.muted = true; element.preload = 'auto'; element.playsInline = true;
    return element;
  });
  useEffect(() => {
    video.src = src; video.load();
    return () => { video.pause(); video.removeAttribute('src'); video.load(); };
  }, [src, video]);
  useLayoutEffect(() => {
    const handle = delayRender('Native video frame');
    const controller = new AbortController();
    const wait = (event: string) => new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer); video.removeEventListener(event, done);
        video.removeEventListener('error', failed); controller.signal.removeEventListener('abort', aborted);
      };
      const done = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error('Native video decode failed')); };
      const aborted = () => { cleanup(); reject(controller.signal.reason); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('Native video frame timeout')); }, limits.renderTimeoutMs);
      video.addEventListener(event, done, { once: true }); video.addEventListener('error', failed, { once: true });
      controller.signal.addEventListener('abort', aborted, { once: true });
    });
    void (async () => {
      if (video.readyState < 2) await wait('loadeddata');
      controller.signal.throwIfAborted();
      const time = Math.min(frame / fps, Math.max(0, video.duration - 1 / fps));
      if (Math.abs(video.currentTime - time) > 0.00001) {
        const seeked = wait('seeked'); video.currentTime = time; await seeked;
      }
      controller.signal.throwIfAborted();
      const target = canvas.current!;
      target.width = video.videoWidth; target.height = video.videoHeight;
      target.getContext('2d')!.drawImage(video, 0, 0);
      continueRender(handle);
    })().catch(reason => { if (!controller.signal.aborted) cancelRender(reason); });
    return () => { controller.abort(); continueRender(handle); };
  }, [frame, fps, src, video, delayRender, continueRender, cancelRender]);
  return h('canvas', { ref: canvas, style: { width: '100%', height: '100%', objectFit: 'contain' } });
}
