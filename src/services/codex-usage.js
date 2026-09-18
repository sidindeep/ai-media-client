function normalizeUsage(value) {
  const count = n => Number.isSafeInteger(n) && n >= 0;
  if (!value || !count(value.input_tokens) || !count(value.output_tokens)) return null;
  const total = value.input_tokens + value.output_tokens;
  if (!count(total)) return null;
  return {
    input_tokens: value.input_tokens, output_tokens: value.output_tokens, total_tokens: total,
    cached_input_tokens: count(value.cached_input_tokens) && value.cached_input_tokens <= value.input_tokens ? value.cached_input_tokens : null,
    reasoning_output_tokens: count(value.reasoning_output_tokens) && value.reasoning_output_tokens <= value.output_tokens ? value.reasoning_output_tokens : null,
  };
}
function parseCodexOutput(output) {
  const events = output.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const completed = events.findLast(event => event?.type === 'turn.completed');
  if (!completed || events.some(event => event?.type === 'turn.failed')) throw new Error('Codex не завершил запрос.');
  return {
    threadId: events.find(event => event?.type === 'thread.started')?.thread_id,
    output: events.filter(event => event?.type === 'item.completed' && event.item?.type === 'agent_message').map(event => event.item.text || '').join('\n\n').trim(),
    usage: normalizeUsage(completed.usage),
  };
}
module.exports = { normalizeUsage, parseCodexOutput };
