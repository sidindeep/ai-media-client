function parseRetryAfter(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  const delay = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) * 1000 : Date.parse(text) - now;
  return Number.isFinite(delay) && delay >= 0 ? Math.min(delay, 24 * 60 * 60 * 1000) : null;
}
module.exports = { parseRetryAfter };
