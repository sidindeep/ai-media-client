class DatabaseAvailability {
  constructor(initialState = { state: 'connecting' }) {
    this.value = { ...initialState };
    this.waiters = new Set();
    this.closed = false;
  }

  snapshot() { return { ...this.value }; }

  update(nextState) {
    this.value = { ...nextState };
    if (!['connected', 'disabled'].includes(this.value.state)) return;
    for (const waiter of this.waiters) waiter(true);
    this.waiters.clear();
  }

  waitUntilAvailable(timeoutMs = 10000) {
    if (['connected', 'disabled'].includes(this.value.state)) return Promise.resolve(true);
    if (this.closed || timeoutMs <= 0) return Promise.resolve(false);
    return new Promise(resolve => {
      let settled = false;
      const finish = available => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters.delete(finish);
        resolve(available);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref?.();
      this.waiters.add(finish);
    });
  }

  close() {
    this.closed = true;
    for (const waiter of this.waiters) waiter(false);
    this.waiters.clear();
  }
}

function createDatabaseAvailability(initialState) {
  return new DatabaseAvailability(initialState);
}

module.exports = { DatabaseAvailability, createDatabaseAvailability };
