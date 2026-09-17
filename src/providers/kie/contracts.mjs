/** Kie-specific wire contracts; no application media vocabulary. */
/**
 * @typedef {{model: string, input: Object, callBackUrl?: string}} KieCreateTaskRequest
 * @typedef {{taskId: string, [key: string]: unknown}} KieCreateTaskData
 * @typedef {{taskId: string, state: string, resultJson?: string,
 *   failCode?: string, failMsg?: string, creditsConsumed?: number,
 *   [key: string]: unknown}} KieTaskData
 * @typedef {{file: Blob, uploadPath: string, fileName?: string}} KieUploadRequest
 * @typedef {{downloadUrl?: string, fileUrl?: string, fileName?: string,
 *   [key: string]: unknown}} KieUploadData
 */
export class KieError extends Error {
  constructor(code, message, { outcome = "not-submitted", status = null } = {}) {
    super(message);
    this.name = "KieError";
    this.code = code;
    this.outcome = outcome;
    this.status = status;
  }
}
export function invalid(message) { throw new KieError("INVALID_REQUEST", message); }
export function httpsUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password) return url.href;
  } catch { /* Do not echo URLs or credentials in errors. */ }
  invalid("A credential-free HTTPS URL is required.");
}
