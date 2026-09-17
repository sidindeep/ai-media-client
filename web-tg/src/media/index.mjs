/** Provider-neutral media contract. No network, storage, or UI ownership. */
export const mediaKinds = Object.freeze(["image", "video", "audio"]);
export const mediaTaskStates = Object.freeze(["queued", "running", "succeeded", "failed", "cancelled", "unknown"]);

/**
 * @typedef {{kind: 'image'|'video'|'audio', role: string, url: string}} MediaAsset
 * @typedef {{modelId: string, prompt?: string, assets?: MediaAsset[], parameters?: Object}} MediaRequest
 * @typedef {{provider: string, modelId: string, id: string}} MediaTaskRef
 * @typedef {{provider: string, modelId: string, id: string, state: string,
 *   outputs: Array<{kind: string, url: string}>, progress: number|null,
 *   usage: {credits: number|null}, error: {code: string, message: string}|null}} MediaTask
 * @typedef {{id: string, listModels: Function, uploadAsset: Function,
 *   submit: Function, getTask: Function}} MediaProvider
 *
 * submit(request, {signal}) returns a serializable MediaTask, never waits for
 * completion. getTask(taskRef, {signal}) performs a single status query.
 * uploadAsset({bytes, name, mimeType, kind, role}, {signal}) returns MediaAsset.
 * Callers persist task refs, poll, download results, and own their job queues.
 */
export class MediaProviderError extends Error {
  constructor(code, message, { outcome = "not-submitted", status = null } = {}) {
    super(message);
    this.name = "MediaProviderError";
    this.code = code;
    this.outcome = outcome;
    this.status = status;
  }
}

export function invalid(message) {
  throw new MediaProviderError("INVALID_REQUEST", message);
}

export function httpsUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password) return url.href;
  } catch { /* Report a stable error without echoing the value. */ }
  invalid("A credential-free HTTPS media URL is required.");
}

/** Register any conforming adapter; adding a provider never changes the service. */
export function createMediaService(providers = []) {
  const registry = new Map();
  for (const provider of providers) {
    if (!provider || typeof provider.id !== "string" || !provider.id.trim()
      || ["listModels", "uploadAsset", "submit", "getTask"].some(key => typeof provider[key] !== "function")) {
      invalid("Invalid media provider interface.");
    }
    if (registry.has(provider.id)) invalid("Duplicate media provider id.");
    registry.set(provider.id, provider);
  }
  const find = id => {
    if (!registry.has(id)) invalid("Unknown media provider.");
    return registry.get(id);
  };
  return Object.freeze({
    listProviders: () => [...registry.keys()],
    listModels: providerId => find(providerId).listModels(),
    uploadAsset: (providerId, asset, options) => find(providerId).uploadAsset(asset, options),
    submit: (providerId, request, options) => find(providerId).submit(request, options),
    getTask: (task, options) => find(task?.provider).getTask(task, options)
  });
}
