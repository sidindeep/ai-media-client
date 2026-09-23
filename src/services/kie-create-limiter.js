// One limiter belongs to one Kie credential in this server process.
function createKieCreateLimiter({ limit = 20, windowMs = 10_000, now = Date.now } = {}) {
  const sent = [];
  const waiting = [];
  let blockedUntil = 0;
  let timer = null;
  function pump() {
    timer = null;
    const time = now();
    while (sent.length && sent[0] <= time - windowMs) sent.shift();
    if (time >= blockedUntil) {
      while (waiting.length && sent.length < limit) {
        sent.push(now());
        waiting.shift()();
      }
    }
    if (waiting.length) {
      const next = Math.max(blockedUntil, sent.length >= limit ? sent[0] + windowMs : 0);
      timer = setTimeout(pump, Math.max(1, next - now()));
    }
  }
  return {
    wait() { return new Promise(resolve => { waiting.push(resolve); if (!timer) pump(); }); },
    rateLimited() { blockedUntil = Math.max(blockedUntil, now() + windowMs); if (timer) clearTimeout(timer); pump(); return blockedUntil; }
  };
}
module.exports = { createKieCreateLimiter };
