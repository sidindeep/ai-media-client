import { invalid, httpsUrl, mediaKinds } from "./index.mjs";

const safeField = value => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]*$/.test(value)
  && !["constructor", "prototype", "__proto__"].includes(value);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

/** Trusted model profiles map semantic fields to Kie wire fields. */
export function prepareModels(profiles) {
  if (!Array.isArray(profiles)) invalid("models must be an array of Kie Market profiles.");
  const models = new Map();
  for (const profile of profiles) {
    const model = structuredClone(profile);
    if (!model || typeof model.id !== "string" || !model.id.trim() || models.has(model.id)
      || typeof model.providerModel !== "string" || !model.providerModel.trim()
      || !mediaKinds.includes(model.kind) || model.protocol !== "market") {
      invalid("Invalid or duplicate Kie Market model profile.");
    }
    model.promptField ??= "prompt";
    model.assets ??= [];
    model.parameters ??= {};
    if (!safeField(model.promptField) || !Array.isArray(model.assets) || !object(model.parameters)) {
      invalid("Invalid model field mapping.");
    }
    const fields = new Set([model.promptField]);
    const roles = new Set();
    for (const binding of model.assets) {
      if (!binding || !mediaKinds.includes(binding.kind) || typeof binding.role !== "string" || !binding.role
        || !safeField(binding.field) || fields.has(binding.field) || roles.has(`${binding.kind}:${binding.role}`)
        || typeof binding.multiple !== "boolean"
        || (binding.maxItems !== undefined && (!Number.isInteger(binding.maxItems) || binding.maxItems < 1))) {
        invalid("Invalid asset mapping.");
      }
      fields.add(binding.field); roles.add(`${binding.kind}:${binding.role}`);
    }
    for (const [key, field] of Object.entries(model.parameters)) {
      if (!safeField(key) || !safeField(field) || fields.has(field)) invalid("Invalid parameter mapping.");
      fields.add(field);
    }
    models.set(model.id, model);
  }
  return models;
}

export function describeModel(model) {
  return {
    id: model.id, name: model.name || model.id, kind: model.kind,
    capabilities: {
      prompt: true, promptRequired: model.promptRequired === true,
      assets: model.assets.map(({ kind, role, multiple, maxItems, required }) => ({
        kind, role, multiple, ...(maxItems === undefined ? {} : { maxItems }), required: required === true
      })),
      parameters: Object.keys(model.parameters), cancellation: false
    }
  };
}

export function buildMarketRequest(model, request) {
  if (!object(request)) invalid("A media request object is required.");
  if (request.prompt !== undefined && typeof request.prompt !== "string") invalid("prompt must be a string.");
  if (model.promptRequired && !request.prompt?.trim()) invalid("This model requires a prompt.");
  const parameters = request.parameters ?? {};
  const assets = request.assets ?? [];
  if (!object(parameters) || !Array.isArray(assets)) invalid("Invalid parameters or assets.");
  const input = {};
  if (request.prompt !== undefined) input[model.promptField] = request.prompt;
  for (const [key, value] of Object.entries(parameters)) {
    if (!Object.hasOwn(model.parameters, key)) invalid("Unsupported model parameter.");
    input[model.parameters[key]] = value;
  }
  for (const asset of assets) {
    if (!asset || !model.assets.some(binding => binding.role === asset.role && binding.kind === asset.kind)) {
      invalid("Unsupported asset kind or role for this model.");
    }
    httpsUrl(asset.url);
  }
  for (const binding of model.assets) {
    const selected = assets.filter(asset => asset.role === binding.role && asset.kind === binding.kind);
    if (binding.required && !selected.length) invalid("A required source asset is missing.");
    if ((!binding.multiple && selected.length > 1) || (binding.maxItems && selected.length > binding.maxItems)) {
      invalid("Too many source assets for this model role.");
    }
    if (selected.length) input[binding.field] = binding.multiple ? selected.map(asset => asset.url) : selected[0].url;
  }
  return { model: model.providerModel, input };
}
