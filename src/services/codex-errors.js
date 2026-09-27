const { safeMessage } = require('../provider-diagnostics');

// Only provider error fields are exposed; never serialize an RPC envelope,
// request, stderr stream, image data, or model reasoning into a user error.
function safeErrorText(value) {
  return safeMessage(value);
}

function providerError(value, fallback = 'Codex request failed.') {
  const parts = [];
  const add = text => { const safe = safeErrorText(text); if (safe && !parts.includes(safe)) parts.push(safe); };
  function visit(item, depth = 0) {
    if (depth > 4 || item == null) return;
    if (typeof item === 'string') {
      try { const parsed = JSON.parse(item); if (parsed && typeof parsed === 'object') { visit(parsed, depth + 1); return; } } catch {}
      add(item); return;
    }
    if (typeof item !== 'object') return;
    for (const key of ['code', 'type', 'httpStatusCode', 'statusCode', 'limitId', 'resetsAt']) {
      if (typeof item[key] === 'string' || typeof item[key] === 'number') add(`${key}: ${item[key]}`);
    }
    visit(item.message, depth + 1);
    visit(item.additionalDetails, depth + 1);
    visit(item.error, depth + 1);
    visit(item.failure, depth + 1);
    if (typeof item.codexErrorInfo === 'string') add(item.codexErrorInfo);
    else if (item.codexErrorInfo && typeof item.codexErrorInfo === 'object') {
      for (const [code, detail] of Object.entries(item.codexErrorInfo).slice(0, 5)) { add(code); visit(detail, depth + 1); }
    }
    const moderation = item.moderation_details;
    if (moderation) {
      if (typeof moderation.moderation_stage === 'string') add(`moderation_stage: ${moderation.moderation_stage}`);
      if (Array.isArray(moderation.categories)) add(`categories: ${moderation.categories.filter(v => typeof v === 'string').join(', ')}`);
    }
  }
  visit(value);
  return new Error(parts.length ? `Codex: ${parts.join(' · ').slice(0, 4000)}` : fallback);
}

function execError(output) {
  let result;
  for (const line of output.split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'turn.failed' || event.type === 'error') result = providerError(event.error || event);
    if (event.type === 'item.completed' && event.item?.type === 'image_generation'
      && ['failed', 'error'].includes(event.item.status)) result = providerError({ failure: event.item.failure, message: event.item.result });
  }
  return result;
}

module.exports = { providerError, safeErrorText, execError };
