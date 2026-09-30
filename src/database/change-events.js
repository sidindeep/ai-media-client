const ACCOUNT_ID = /^[a-f0-9-]{36}$/;
const systemErrors = require('../system-errors');

function listenForAccountChanges(pool, onAccount) {
  let closed = false, client = null, timer = null, retryMs = 1000;
  const schedule = () => {
    if (closed || timer) return;
    timer = setTimeout(() => { timer = null; void connect(); }, retryMs);
    timer.unref?.();
    retryMs = Math.min(retryMs * 2, 30000);
  };
  async function connect() {
    if (closed || client) return;
    let next;
    try {
      next = await pool.connect();
      if (closed) { next.release(); return; }
      if (typeof next.on !== 'function') { next.release(); return; }
      await next.query('LISTEN media_account_changed');
      client = next;
      retryMs = 1000;
      const lost = error => {
        if (client !== next) return;
        if (!closed) systemErrors.record('database', 'change-listener-lost.error', error);
        client = null;
        next.release(new Error('Change listener connection lost'));
        schedule();
      };
      next.on('notification', message => {
        if (message.channel !== 'media_account_changed' || !ACCOUNT_ID.test(message.payload || '')) return;
        void Promise.resolve().then(() => onAccount(message.payload)).catch(error => systemErrors.record('database', 'account-notification.error', error));
      });
      next.once('error', lost);
      next.once('end', lost);
    } catch (error) {
      next?.release(error);
      if (!closed) { systemErrors.record('database', 'change-listener.error', error); schedule(); }
    }
  }
  void connect();
  return { close: async () => {
    closed = true;
    if (timer) clearTimeout(timer);
    if (client) {
      const current = client; client = null;
      await current.query('UNLISTEN media_account_changed').catch(() => {});
      current.release();
    }
  } };
}

module.exports = { listenForAccountChanges };
