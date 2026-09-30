const ACCOUNT_ID = /^[a-f0-9-]{36}$/;
const systemErrors = require('../system-errors');

function listenForAccountChanges(pool, onAccount, { heartbeatMs = 30000 } = {}) {
  let closed = false, session = null, timer = null, retryMs = 1000, connecting = false;
  const schedule = () => {
    if (closed || timer) return;
    timer = setTimeout(() => { timer = null; void connect(); }, retryMs);
    timer.unref?.();
    retryMs = Math.min(retryMs * 2, 30000);
  };
  async function connect() {
    if (closed || session || connecting) return;
    connecting = true;
    let next, current;
    try {
      next = await pool.connect();
      if (closed || typeof next.on !== 'function') { next.release(); return; }
      let heartbeat = null, disposed = false, busy = false;
      const notification = message => {
        if (message.channel !== 'media_account_changed' || !ACCOUNT_ID.test(message.payload || '')) return;
        void Promise.resolve().then(() => onAccount(message.payload)).catch(error => systemErrors.record('database', 'account-notification.error', error));
      };
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        if (heartbeat) clearInterval(heartbeat);
        next.removeListener('notification', notification);
        next.removeListener('error', lost);
        next.removeListener('end', lost);
        if (session === current) session = null;
        // Destroy the dedicated LISTEN connection, never return it to the pool.
        next.release(true);
      };
      const lost = error => {
        if (disposed) return;
        if (!closed) systemErrors.record('database', 'change-listener-lost.error', error);
        dispose(); schedule();
      };
      current = { dispose }; session = current;
      next.on('notification', notification);
      next.on('error', lost);
      next.once('end', lost);
      await next.query('LISTEN media_account_changed');
      if (closed || disposed) { dispose(); return; }
      retryMs = 1000;
      heartbeat = setInterval(() => {
        if (busy || closed || disposed) return;
        busy = true;
        void next.query({ text: 'SELECT 1', query_timeout: 5000 }).catch(lost).finally(() => { busy = false; });
      }, heartbeatMs);
      heartbeat.unref?.();
    } catch (error) {
      if (current) current.dispose(); else next?.release(error);
      if (!closed) { systemErrors.record('database', 'change-listener.error', error); schedule(); }
    } finally { connecting = false; }
  }
  void connect();
  return { close: async () => {
    closed = true;
    if (timer) clearTimeout(timer);
    session?.dispose();
  } };
}

module.exports = { listenForAccountChanges };
