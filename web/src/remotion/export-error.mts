// Only fixed technical categories cross the logger boundary. Never send the
// renderer message: it may contain source URLs, filenames or on-screen text.
export type ExportStage = 'support' | 'media' | 'render' | 'output';
export function exportFailure(reason: unknown, stage: ExportStage) {
  const name = reason instanceof Error ? reason.name : '';
  const message = reason instanceof Error ? reason.message : '';
  const category = /fetch|network|HTTP \d|load failed/i.test(message) ? 'NETWORK'
    : /decode|MOVIE_MEDIA_UNSUPPORTED/i.test(message) ? 'DECODE'
    : /encode|EncodingError/i.test(message + name) ? 'ENCODE'
    : /timed? out|timeout/i.test(message) ? 'TIMEOUT'
    : /memory|cache size|allocation/i.test(message) ? 'MEMORY'
    : /SecurityError|Content Security|CSP/i.test(message + name) ? 'SECURITY'
    : /not supported|unsupported|NotSupportedError/i.test(message + name) ? 'UNSUPPORTED'
    : 'UNKNOWN';
  return `${stage}:${category}`;
}
export class MovieExportError extends Error {
  failure: string;
  constructor(failure: string) { super('MOVIE_EXPORT_FAILED'); this.failure = failure; }
}
