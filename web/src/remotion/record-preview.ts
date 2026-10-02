import type { PlayerRef } from '@remotion/player';
import { finalizeRecording } from './finalize-recording.mjs';
type CroppableTrack = MediaStreamTrack & { cropTo: (target: unknown) => Promise<void> };
type CaptureWindow = Window & { CropTarget?: { fromElement: (element: HTMLElement) => Promise<unknown> } };

export async function recordPreview(player: PlayerRef, element: HTMLElement, frames: number, fps: number,
  needsAudio: boolean, signal: AbortSignal, onProgress: (progress: number) => void) {
  const crop = (window as CaptureWindow).CropTarget;
  if (!crop || !navigator.mediaDevices?.getDisplayMedia || typeof MediaRecorder === 'undefined') throw new Error('PREVIEW_RECORD_UNSUPPORTED');
  signal.throwIfAborted();
  const scroller = element.closest<HTMLElement>('.movie-editor');
  if (scroller) scroller.scrollTop += element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16;
  // Called in the user's click gesture. Recording starts only after cropTo
  // restricts capture to this application's composition, excluding controls.
  const capture = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'browser' },
    audio: { suppressLocalAudioPlayback: false }, preferCurrentTab: true,
    selfBrowserSurface: 'include', surfaceSwitching: 'exclude', monitorTypeSurfaces: 'exclude' } as DisplayMediaStreamOptions);
  let recorder: MediaRecorder | undefined;
  const previousFrame = player.getCurrentFrame(), wasPlaying = player.isPlaying();
  player.pause();
  try {
    signal.throwIfAborted();
    const track = capture.getVideoTracks()[0] as CroppableTrack;
    if (!track?.cropTo || track.getSettings().displaySurface !== 'browser') throw new Error('PREVIEW_RECORD_TAB_REQUIRED');
    // A crop is acknowledged on a captured frame. Warm up playback so a
    // paused/static preview produces that frame, then rewind before recording.
    player.play();
    await track.cropTo(await crop.fromElement(element));
    if (needsAudio && !capture.getAudioTracks().length) throw new Error('PREVIEW_RECORD_AUDIO_REQUIRED');
    const mimeType = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp8'].find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error('PREVIEW_RECORD_UNSUPPORTED');
    signal.throwIfAborted(); player.pause(); player.seekTo(0);
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    recorder = new MediaRecorder(capture, { mimeType, videoBitsPerSecond: 2_500_000, audioBitsPerSecond: 128_000,
      videoKeyFrameIntervalDuration: 1000 } as MediaRecorderOptions);
    const recording = recorder, chunks: Blob[] = [];
    const recorded = await new Promise<Blob>((resolve, reject) => {
      let finished = false;
      const cleanup = () => {
        clearTimeout(timeout); signal.removeEventListener('abort', abort); track.removeEventListener('ended', stopped);
        player.removeEventListener('ended', ended); player.removeEventListener('frameupdate', progress); player.removeEventListener('error', failed);
      };
      const fail = (reason: unknown) => { if (finished) return; finished = true; cleanup(); reject(reason); };
      const abort = () => fail(signal.reason), stopped = () => fail(new Error('PREVIEW_RECORD_STOPPED'));
      const failed = () => fail(new Error('PREVIEW_RECORD_FAILED'));
      const progress = ({ detail }: { detail: { frame: number } }) => onProgress(Math.min(0.9, (detail.frame + 1) / frames * 0.9));
      const ended = () => { if (recording.state !== 'inactive') recording.stop(); };
      const timeout = setTimeout(() => fail(new Error('PREVIEW_RECORD_TIMEOUT')), frames / fps * 1000 + 120000);
      recording.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recording.onerror = failed;
      recording.onstop = () => {
        if (finished) return;
        finished = true; cleanup();
        const blob = new Blob(chunks, { type: recording.mimeType });
        if (blob.size) resolve(blob); else reject(new Error('PREVIEW_RECORD_FAILED'));
      };
      signal.addEventListener('abort', abort, { once: true }); track.addEventListener('ended', stopped, { once: true });
      player.addEventListener('ended', ended); player.addEventListener('frameupdate', progress); player.addEventListener('error', failed);
      if (signal.aborted) { abort(); return; }
      try { recording.start(1000); player.play(); } catch (reason) { fail(reason); }
    });
    capture.getTracks().forEach(track => track.stop());
    return await finalizeRecording(recorded, signal, value => onProgress(0.9 + value * 0.1));
  } finally {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    capture.getTracks().forEach(track => track.stop());
    player.pause(); player.seekTo(previousFrame);
    if (wasPlaying && !signal.aborted) player.play();
  }
}
