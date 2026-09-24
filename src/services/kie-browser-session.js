const dns = require('node:dns/promises');

// The browser owns its Kie credentials. Only a boolean login state crosses CDP.
function createKieBrowserSession({ cdpUrl = '', loginUrl = '', fetchImpl = fetch, socketFactory = url => new WebSocket(url) } = {}) {
  async function status() {
    if (!cdpUrl || !loginUrl) return { state: 'unavailable', loginUrl: null };
    try {
      const endpoint = new URL(cdpUrl);
      if (endpoint.protocol !== 'http:') throw new Error('Invalid CDP endpoint');
      const { address } = await dns.lookup(endpoint.hostname);
      endpoint.hostname = address;
      const response = await fetchImpl(new URL('/json/list', endpoint), { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('Browser unavailable');
      const targets = await response.json();
      const page = targets.find(item => item.type === 'page' && /^https:\/\/(?:www\.)?kie\.ai(?:\/|$)/.test(item.url));
      if (!page?.webSocketDebuggerUrl) return { state: 'disconnected', loginUrl };
      const socketUrl = new URL(page.webSocketDebuggerUrl);
      socketUrl.hostname = address;
      const connected = await new Promise((resolve, reject) => {
        const socket = socketFactory(socketUrl.href);
        let settled = false;
        const timer = setTimeout(() => finish(false, new Error('Browser timed out')), 5000);
        const finish = (result, error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.close();
          if (error) reject(error); else resolve(result);
        };
        socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
          expression: "Boolean(document.cookie.split('; ').some(row => row.startsWith('authorization=')))",
          returnByValue: true,
        } }));
        socket.onmessage = event => {
          const value = JSON.parse(event.data);
          if (value.id === 1) finish(value.result?.result?.value === true);
        };
        socket.onerror = () => finish(false, new Error('Browser connection failed'));
      });
      return { state: connected ? 'connected' : 'disconnected', loginUrl };
    } catch {
      return { state: 'unavailable', loginUrl };
    }
  }
  return { status };
}

module.exports = { createKieBrowserSession };
