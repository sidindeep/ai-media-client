const { createCodexAppServer } = require('./codex-app-server');

function createCodexAppServerPool({ size = Number(process.env.MEDIA_CODEX_POOL_SIZE || 2),
  concurrency = Number(process.env.MEDIA_CODEX_PROCESS_CONCURRENCY || 128),
  createAdapter = createCodexAppServer } = {}) {
  if (!Number.isSafeInteger(size) || size < 1 || size > 32 ||
      !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 128) {
    throw new Error('Invalid Codex pool size (1..32) or process concurrency (1..128)');
  }
  const slots = Array.from({ length: size }, () => ({ adapter: createAdapter(), active: 0 }));
  const queue = [];
  let closed = false;
  const cancelled = () => new Error('Codex request cancelled before execution.');
  function drain() {
    while (!closed && queue.length) {
      const slot = slots.reduce((best, candidate) => candidate.active < best.active ? candidate : best);
      if (slot.active >= concurrency) return;
      const job = queue.shift();
      job.signal?.removeEventListener('abort', job.abort);
      if (job.signal?.aborted) { job.reject(cancelled()); continue; }
      slot.active++;
      void Promise.resolve().then(() => slot.adapter.run(job.request, { signal: job.signal }))
        .then(job.resolve, job.reject).finally(() => { slot.active--; drain(); });
    }
  }
  return {
    rateLimits: () => slots[0].adapter.rateLimits(),
    run(request, { signal } = {}) {
      if (closed || signal?.aborted) return Promise.reject(cancelled());
      return new Promise((resolve, reject) => {
        const job = { request, signal, resolve, reject };
        job.abort = () => {
          const index = queue.indexOf(job);
          if (index !== -1) { queue.splice(index, 1); reject(cancelled()); }
        };
        signal?.addEventListener('abort', job.abort, { once: true });
        queue.push(job); drain();
      });
    },
    close() {
      closed = true;
      for (const job of queue.splice(0)) {
        job.signal?.removeEventListener('abort', job.abort); job.reject(cancelled());
      }
      for (const slot of slots) slot.adapter.close();
    },
    status() {
      return { size, concurrencyPerProcess: concurrency, capacity: size * concurrency,
        queued: queue.length, active: slots.reduce((n, slot) => n + slot.active, 0),
        processes: slots.map(slot => ({ ...slot.adapter.status(), active: slot.active })) };
    },
  };
}
module.exports = { createCodexAppServerPool };
