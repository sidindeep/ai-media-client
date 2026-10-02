import { ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Mp4OutputFormat, Output, WebMOutputFormat } from 'mediabunny';

// MediaRecorder files are streaming containers. Finalize their duration and
// seek index before download; never deliver Chrome's changing H.264 config.
export async function finalizeRecording(blob: Blob, signal: AbortSignal, onProgress: (value: number) => void) {
  for (const mp4 of [true, false]) {
    signal.throwIfAborted();
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
    const target = new BufferTarget();
    const output = new Output({ format: mp4 ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(), target });
    let conversion: Conversion | undefined;
    const abort = () => { void conversion?.cancel(); input.dispose(); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      const track = await input.getPrimaryVideoTrack();
      if (!track) throw new Error('PREVIEW_RECORD_FAILED');
      const width = Math.max(2, Math.round(track.displayWidth / 2) * 2);
      const height = Math.max(2, Math.round(track.displayHeight / 2) * 2);
      conversion = await Conversion.init({ input, output, tracks: 'primary', showWarnings: false,
        ...(mp4 ? { video: { codec: 'avc' as const, width, height, forceTranscode: true, hardwareAcceleration: 'prefer-software' as const, keyFrameInterval: 1, quality: 2_500_000 }, audio: { codec: 'aac' as const, quality: 128_000 } } : { copy: { mode: 'forced' as const } }) });
      if (!conversion.isValid || conversion.discardedTracks.length) throw new Error('PREVIEW_RECORD_FAILED');
      conversion.onProgress = value => onProgress(value);
      signal.throwIfAborted();
      await conversion.execute();
      signal.throwIfAborted();
      if (!target.buffer?.byteLength) throw new Error('PREVIEW_RECORD_FAILED');
      return new Blob([target.buffer], { type: mp4 ? 'video/mp4' : 'video/webm' });
    } catch (reason) {
      await conversion?.cancel();
      if (signal.aborted) throw signal.reason;
      if (!mp4) throw reason;
    } finally { signal.removeEventListener('abort', abort); input.dispose(); }
  }
  throw new Error('PREVIEW_RECORD_FAILED');
}
