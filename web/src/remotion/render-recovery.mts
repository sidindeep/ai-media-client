export async function renderWithRecovery<T>(render: (nativeVideo: boolean) => Promise<T>, signal: AbortSignal,
  hasVideo: boolean, isRecoverable: (reason: unknown) => boolean, onRetry: () => void) {
  try { return await render(false); }
  catch (reason) {
    signal.throwIfAborted();
    if (!hasVideo || !isRecoverable(reason)) throw reason;
    onRetry();
    return await render(true);
  }
}
