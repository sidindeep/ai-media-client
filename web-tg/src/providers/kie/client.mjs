import { KieError, invalid, httpsUrl } from "./contracts.mjs";
export { KieError } from "./contracts.mjs";

const defaults = Object.freeze({
  baseUrl: "https://api.kie.ai",
  uploadUrl: "https://kieai.redpandaai.co/api/file-stream-upload",
  createPath: "/api/v1/jobs/createTask",
  taskPath: "/api/v1/jobs/recordInfo",
  timeoutMs: 60_000, uploadTimeoutMs: 180_000
});

export function createKieClient(options = {}) {
  const config = { ...defaults, ...options };
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") invalid("fetch is required.");
  for (const key of ["timeoutMs", "uploadTimeoutMs"]) {
    if (!Number.isInteger(config[key]) || config[key] <= 0) invalid("Timeouts must be positive integers.");
  }
  const baseUrl = httpsUrl(config.baseUrl);
  const uploadUrl = httpsUrl(config.uploadUrl);
  const endpoint = path => {
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) invalid("Invalid Kie API path.");
    const url = new URL(path, baseUrl);
    if (url.origin !== new URL(baseUrl).origin) invalid("Kie API path must remain on the configured origin.");
    return url.href;
  };
  const createUrl = endpoint(config.createPath);
  const taskUrl = endpoint(config.taskPath);
  async function call(url, init, { signal, submission = false, timeoutMs = config.timeoutMs } = {}) {
    if (typeof config.apiKey !== "string" || !config.apiKey.trim()) {
      throw new KieError("NOT_CONFIGURED", "Kie API key is not configured.");
    }
    if (signal?.aborted) throw new KieError("ABORTED", "Operation cancelled before sending.");
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    try {
      let response, body;
      try {
        response = await fetchImpl(url, {
          ...init, redirect: "error", signal: controller.signal,
          headers: { ...init.headers, Authorization: `Bearer ${config.apiKey.trim()}` }
        });
        body = await response.json();
      } catch {
        throw new KieError("TRANSPORT_ERROR", "Kie response could not be received.", {
          outcome: submission ? "unknown" : "not-submitted"
        });
      }
      if (!response.ok || body?.success === false || (body?.code !== undefined && body.code !== 200)) {
        const status = response.ok ? body?.code : response.status;
        const rejected = [400, 401, 402, 403, 404, 422, 429].includes(status);
        throw new KieError(status === 402 ? "INSUFFICIENT_CREDITS" : "PROVIDER_ERROR",
          "Kie rejected the request or returned an error.", {
            status: typeof status === "number" ? status : null,
            outcome: submission ? (rejected ? "rejected" : "unknown") : "not-submitted"
          });
      }
      return body?.data;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  return Object.freeze({
    /** @param {import('./contracts.mjs').KieUploadRequest} request */
    async uploadFile(request, { signal } = {}) {
      if (!(request?.file instanceof Blob) || !request.file.size
        || typeof request.uploadPath !== "string" || !request.uploadPath.trim()
        || (request.fileName !== undefined && (typeof request.fileName !== "string" || !request.fileName.trim()))) {
        invalid("Kie upload requires file Blob, uploadPath and optional fileName.");
      }
      const form = new FormData();
      form.append("file", request.file, request.fileName || "upload");
      form.append("uploadPath", request.uploadPath);
      if (request.fileName !== undefined) form.append("fileName", request.fileName);
      const data = await call(uploadUrl, { method: "POST", body: form }, { signal, timeoutMs: config.uploadTimeoutMs });
      try { httpsUrl(data?.downloadUrl || data?.fileUrl); }
      catch { throw new KieError("INVALID_RESPONSE", "Kie returned no valid upload URL."); }
      return data;
    },
    /** @param {import('./contracts.mjs').KieCreateTaskRequest} request */
    async createTask(request, { signal } = {}) {
      if (!request || typeof request.model !== "string" || !request.model.trim()
        || !request.input || typeof request.input !== "object" || Array.isArray(request.input)) {
        invalid("Kie creation requires model and input.");
      }
      if (Object.keys(request).some(key => !["model", "input", "callBackUrl"].includes(key))) invalid("Unsupported Kie creation field.");
      if (request.callBackUrl !== undefined) httpsUrl(request.callBackUrl);
      let serialized;
      try {
        serialized = JSON.stringify(request, (_key, value) => {
          if (value === undefined || typeof value === "function" || typeof value === "symbol"
            || (typeof value === "number" && !Number.isFinite(value))) throw new Error();
          return value;
        });
      } catch { invalid("Kie request must be JSON serializable."); }
      const data = await call(createUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: serialized }, { signal, submission: true });
      if (typeof data?.taskId !== "string" || !data.taskId.trim()) {
        throw new KieError("INVALID_RESPONSE", "Kie did not return a task id; do not resubmit automatically.", { outcome: "unknown" });
      }
      return data;
    },
    /** Returns Kie data unchanged, including provider status/resultJson. */
    async getTask({ taskId } = {}, { signal } = {}) {
      if (typeof taskId !== "string" || !taskId.trim()) invalid("Kie taskId is required.");
      const url = new URL(taskUrl);
      url.searchParams.set("taskId", taskId);
      const data = await call(url.href, { method: "GET" }, { signal });
      if (!data || data.taskId !== taskId || typeof data.state !== "string" || !data.state) {
        throw new KieError("INVALID_RESPONSE", "Kie returned an invalid task identity or state.");
      }
      return data;
    }
  });
}
