// Application-owned provider boundary. Transport clients keep their native APIs.
const KINDS = new Set(['text', 'image', 'video', 'audio']);
const BILLING = new Set(['wallet', 'external', 'subscription']);

/**
 * Required provider surface:
 * id, name, kinds, billing, listModels, quote, submit, getTask, getStatus.
 * uploadAsset is optional and advertised through supportsUpload. The app owns
 * the wallet, history and retries; a provider never retries an uncertain submit.
 *
 * quote returns { status: 'exact'|'estimated'|'unavailable'|'external', credits: number|null }.
 * Provider-native cost and product credits are separate values. In particular,
 * external billing never means a zero-cost request.
 */
function defineProvider(definition) {
  if (!definition || typeof definition.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(definition.id)
    || typeof definition.name !== 'string' || !definition.name.trim()
    || !Array.isArray(definition.kinds) || !definition.kinds.length
    || definition.kinds.some(kind => !KINDS.has(kind))
    || !definition.billing || !BILLING.has(definition.billing.mode)
    || ['listModels', 'quote', 'submit', 'getTask', 'getStatus'].some(key => typeof definition[key] !== 'function')
    || (definition.supportsUpload === true && typeof definition.uploadAsset !== 'function')) {
    throw new TypeError('Invalid application provider contract');
  }
  return Object.freeze({ ...definition, kinds: Object.freeze([...new Set(definition.kinds)]),
    billing: Object.freeze({ ...definition.billing }) });
}

module.exports = { defineProvider };
