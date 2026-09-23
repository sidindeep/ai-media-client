// Offline contract check for every effective Kie catalog entry. Official docs
// remain the source of truth; model-specific prose rules need separate review.
const Ajv = require('ajv');
const { models } = require('../src/catalog');

const ajv = new Ajv({ strict: false, validateFormats: false });
const errors = [];
const ids = new Set();
const apiModels = new Set();

function matchesType(type, value) {
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  return typeof value === type;
}

for (const model of models) {
  const name = model.apiModel || model.id;
  if (ids.has(model.id)) errors.push(`${name}: duplicate catalog id`);
  if (apiModels.has(name)) errors.push(`${name}: duplicate API model`);
  ids.add(model.id);
  apiModels.add(name);
  if (model.providerId !== 'kie') errors.push(`${name}: wrong provider`);
  if (!model.source?.startsWith('https://docs.kie.ai/')) errors.push(`${name}: missing official documentation source`);
  if (!model.inputSchema) {
    errors.push(`${name}: missing input schema`);
    continue;
  }
  try { ajv.compile(model.inputSchema); }
  catch (error) { errors.push(`${name}: invalid input schema: ${error.message}`); }
  if (model.inputSchema.type !== 'object') {
    if (!(model.inputSchema.oneOf?.length || model.inputSchema.anyOf?.length)) errors.push(`${name}: unsupported input schema`);
    if (!model.fields.some(field => field.key === '__input')) errors.push(`${name}: union schema has no structured input field`);
    continue;
  }
  const fields = new Map(model.fields.map(field => [field.key, field]));
  for (const [key, schema] of Object.entries(model.inputSchema.properties || {})) {
    const field = fields.get(key);
    if (!field) { errors.push(`${name}.${key}: no form field`); continue; }
    for (const [label, value] of [['default', field.default], ...(field.options || []).map((option, index) => [`option ${index}`, option])]) {
      if (value === undefined) continue;
      if (schema.type && !matchesType(schema.type, value)) errors.push(`${name}.${key}: ${label} does not match ${schema.type}`);
      if (schema.enum && !schema.enum.includes(value)) errors.push(`${name}.${key}: ${label} is outside schema enum`);
    }
  }
  for (const key of model.inputSchema.required || []) {
    if (!fields.has(key)) errors.push(`${name}.${key}: required field unavailable`);
  }
  for (const field of model.fields) {
    if (field.key !== '__input' && !Object.hasOwn(model.inputSchema.properties || {}, field.key)) {
      errors.push(`${name}.${field.key}: field absent from input schema`);
    }
  }
}

if (errors.length) {
  console.error(`Kie catalog contract: ${errors.length} errors across ${models.length} models`);
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else console.log(`Kie catalog contract: ${models.length} models passed`);
