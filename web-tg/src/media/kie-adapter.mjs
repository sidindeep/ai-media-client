import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { MediaProviderError, invalid, httpsUrl, mediaKinds } from './index.mjs';
import { prepareModels, describeModel, buildMarketRequest } from './kie-models.mjs';

const states = Object.freeze({ waiting: 'queued', queuing: 'queued', generating: 'running', success: 'succeeded', fail: 'failed' });

/** App-owned translation. client implements Kie's own createTask/getTask/uploadFile. */
export function createKieMediaAdapter({ client, models = [], uploadPath } = {}) {
  if (!client || ['createTask', 'getTask', 'uploadFile'].some(key => typeof client[key] !== 'function')) invalid('A Kie client is required.');
  const profiles = prepareModels(models);
  const find = id => {
    if (!profiles.has(id)) invalid('Unknown model id.');
    return profiles.get(id);
  };
  const task = (model, id, state = 'queued') => ({
    provider: 'kie', modelId: model.id, id, state,
    outputs: [], progress: null, usage: { credits: null }, error: null
  });
  const invoke = async operation => {
    try { return await operation(); }
    catch (error) {
      throw new MediaProviderError(typeof error?.code === 'string' ? error.code : 'PROVIDER_ERROR', 'Kie operation failed.', {
        outcome: error?.outcome || 'unknown', status: typeof error?.status === 'number' ? error.status : null
      });
    }
  };
  return Object.freeze({
    id: 'kie',
    listModels: () => [...profiles.values()].map(describeModel),
    async uploadAsset(asset, options) {
      if (!asset || !mediaKinds.includes(asset.kind) || typeof asset.role !== 'string' || !asset.role
        || !(asset.bytes instanceof Uint8Array) || !asset.bytes.length
        || typeof asset.name !== 'string' || !asset.name
        || typeof asset.mimeType !== 'string' || !asset.mimeType.startsWith(`${asset.kind}/`)
        || typeof uploadPath !== 'string' || !uploadPath.trim()) invalid('Invalid media upload or upload directory.');
      const extension = extname(asset.name);
      const fileName = randomUUID() + (/^\.[a-z0-9]{1,10}$/i.test(extension) ? extension : '');
      const data = await invoke(() => client.uploadFile({
        file: new Blob([asset.bytes], { type: asset.mimeType }), uploadPath, fileName
      }, options));
      try { return { kind: asset.kind, role: asset.role, url: httpsUrl(data?.downloadUrl || data?.fileUrl) }; }
      catch { throw new MediaProviderError('INVALID_RESPONSE', 'Invalid uploaded asset URL.'); }
    },
    async submit(request, options) {
      const model = find(request?.modelId);
      const body = buildMarketRequest(model, request);
      const data = await invoke(() => client.createTask(body, options));
      if (typeof data?.taskId !== 'string' || !data.taskId.trim()) throw new MediaProviderError('INVALID_RESPONSE', 'Missing task id.', { outcome: 'unknown' });
      return task(model, data.taskId);
    },
    async getTask(ref, options) {
      if (ref?.provider !== 'kie' || typeof ref.id !== 'string' || !ref.id.trim()) invalid('Invalid task reference.');
      const model = find(ref.modelId);
      const data = await invoke(() => client.getTask({ taskId: ref.id }, options));
      const state = Object.hasOwn(states, data?.state ?? '') ? states[data.state] : null;
      if (!state || data.taskId !== ref.id || (data.model && data.model !== model.providerModel)) {
        throw new MediaProviderError('INVALID_RESPONSE', 'Invalid task identity or status.');
      }
      const result = task(model, ref.id, state);
      if (state === 'succeeded') {
        try {
          const parsed = typeof data.resultJson === 'string' ? JSON.parse(data.resultJson) : data.resultJson;
          if (!Array.isArray(parsed?.resultUrls) || !parsed.resultUrls.length) throw new Error();
          result.outputs = parsed.resultUrls.map(url => ({ kind: model.kind, url: httpsUrl(url) }));
        } catch { throw new MediaProviderError('INVALID_RESPONSE', 'Invalid media results.'); }
      }
      if (typeof data.progress === 'number' && Number.isFinite(data.progress) && data.progress >= 0 && data.progress <= 100) result.progress = data.progress;
      if (typeof data.creditsConsumed === 'number' && Number.isFinite(data.creditsConsumed) && data.creditsConsumed >= 0) result.usage.credits = data.creditsConsumed;
      if (state === 'failed') result.error = { code: 'GENERATION_FAILED', message: 'Media generation failed at Kie.' };
      return result;
    }
  });
}
