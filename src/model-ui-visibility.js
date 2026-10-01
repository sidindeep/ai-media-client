// Presentation policy only. Never remove API properties, defaults or required keys.
const policy = require('../config/model-ui-parameters.json');
const allowed = Object.fromEntries(['kie', 'apimart'].map(provider =>
  [provider, new Set(policy.parameters.flatMap(parameter => parameter[provider]))]));
const reason = 'absent-from-ui-parameter-table';

// Required values and the containers needed to edit them take precedence over
// the spreadsheet. The exception is local to the model/path, not a global alias.
function requiredUiPaths(model) {
  const required = new Set();
  const controls = new Set();
  function walk(node, path = '') {
    if (!node || typeof node !== 'object') return;
    const prefix = path === '__input' ? '' : path;
    // Conditional/allOf fragments can require properties declared elsewhere.
    for (const key of node.required || []) required.add(prefix ? `${prefix}.${key}` : key);
    for (const [key, child] of Object.entries(node.properties || {})) {
      const childPath = prefix ? `${prefix}.${key}` : key;
      walk(child, childPath);
    }
    if (node.items && !Array.isArray(node.items)) walk(node.items, `${prefix}[]`);
    for (const union of ['oneOf', 'anyOf', 'allOf']) for (const variant of node[union] || []) walk(variant, path);
    if (node.then?.required?.length || node.else?.required?.length) {
      for (const key of Object.keys(node.if?.properties || {})) controls.add(prefix ? `${prefix}.${key}` : key);
    }
    for (const branch of ['then', 'else']) walk(node[branch], path);
  }
  for (const field of model.fields || []) {
    if (field.required && field.key !== '__input') required.add(field.key);
    walk(field.schema, field.key);
  }
  walk(model.inputSchema);
  const visible = new Set([...required, ...controls]);
  for (const path of [...required, ...controls]) {
    let parent = path;
    while (parent.includes('.') || parent.endsWith('[]')) {
      parent = parent.endsWith('[]') ? parent.slice(0, -2) : parent.slice(0, parent.lastIndexOf('.'));
      visible.add(parent);
    }
  }
  return { required, controls, visible };
}

function mark(node, path, provider, exceptions) {
  if (!node || typeof node !== 'object') return;
  if (path && path !== '__input' && !allowed[provider].has(path)) {
    if (exceptions.visible.has(path)) {
      delete node.uiHidden; delete node.uiHiddenReason;
      node.uiVisibleReason = exceptions.required.has(path) ? 'required-for-generation'
        : exceptions.controls.has(path) ? 'required-condition-control' : 'required-child-container';
    } else {
      node.uiHidden = true;
      node.uiHiddenReason = reason;
    }
  }
  const prefix = path === '__input' ? '' : path;
  for (const [key, child] of Object.entries(node.properties || {})) {
    mark(child, prefix ? `${prefix}.${key}` : key, provider, exceptions);
  }
  if (node.items && !Array.isArray(node.items)) mark(node.items, `${prefix}[]`, provider, exceptions);
  // A container/item is not a parameter itself. Only named properties are hidden.
  if (node.items) { delete node.items.uiHidden; delete node.items.uiHiddenReason; }
  for (const union of ['oneOf', 'anyOf', 'allOf']) {
    for (const variant of node[union] || []) {
      mark(variant, path, provider, exceptions);
      delete variant.uiHidden; delete variant.uiHiddenReason;
    }
  }
}

function applyModelUiVisibility(model, provider = model.providerId) {
  if (!allowed[provider]) return model;
  const result = structuredClone(model);
  const exceptions = requiredUiPaths(result);
  for (const field of result.fields || []) {
    mark(field, field.key, provider, exceptions);
    mark(field.schema, field.key, provider, exceptions);
  }
  mark(result.inputSchema, '', provider, exceptions);
  return result;
}

// Read-only projection for the Telegram draft preview, not for request building.
function visibleUiInput(model, input) {
  function project(schema, value) {
    if (Array.isArray(value)) return value.map(item => project(schema?.items, item));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => !schema?.properties?.[key]?.uiHidden)
      .map(([key, child]) => [key, project(schema?.properties?.[key], child)]));
  }
  const fields = new Map((model.fields || []).map(field => [field.key, field]));
  return Object.fromEntries(Object.entries(input).filter(([key]) => fields.has(key) && !fields.get(key).uiHidden)
    .map(([key, value]) => [key, project(fields.get(key).schema, value)]));
}

module.exports = { applyModelUiVisibility, visibleUiInput };
