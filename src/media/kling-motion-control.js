const kieModels = new Set(['kie:kling-2.6/motion-control', 'kie:kling-3.0/motion-control']);
const apimartModels = new Set(['apimart:kling-v2-6-motion-control', 'apimart:kling-v3-motion-control']);
const resolutions = new Map([['std', '720p'], ['pro', '1080p'], ['720p', '720p'], ['1080p', '1080p']]);

// These mode values express the same resolution only for Motion Control.
function motionControlMode(modelId, value) {
  const resolution = resolutions.get(String(value).toLowerCase());
  if (!resolution) return value;
  if (kieModels.has(modelId)) return resolution;
  if (apimartModels.has(modelId)) return resolution === '720p' ? 'std' : 'pro';
  return value;
}

module.exports = { motionControlMode };
