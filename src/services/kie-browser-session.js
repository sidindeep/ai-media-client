const dns = require('node:dns/promises');

// Credentials stay in Chromium's profile. The API returns only login state and
// browser pixels; it never returns cookies or CDP access to the client.
function createKieBrowserSession({ cdpUrl = '', loginUrl = '', embedded = false, fetchImpl = fetch, socketFactory = url => new WebSocket(url) } = {}) {
  async function targets() {
    if (!cdpUrl) throw new Error('Browser not configured');
    const endpoint = new URL(cdpUrl);
    if (endpoint.protocol !== 'http:') throw new Error('Invalid CDP endpoint');
    const { address } = await dns.lookup(endpoint.hostname);
    endpoint.hostname = address;
    const response = await fetchImpl(new URL('/json/list', endpoint), { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Browser unavailable');
    const list = await response.json();
    return { address, pages: list.filter(item => item.type === 'page' && item.webSocketDebuggerUrl) };
  }

  function kiePage(pages) {
    return pages.find(item => /^https:\/\/(?:www\.)?kie\.ai(?:\/|$)/.test(item.url));
  }

  function activePage(pages) {
    return pages.find(item => /^https?:\/\//.test(item.url) && !kiePage([item])) || kiePage(pages);
  }

  async function command(page, address, method, params = {}) {
    const socketUrl = new URL(page.webSocketDebuggerUrl);
    socketUrl.hostname = address;
    return new Promise((resolve, reject) => {
      const socket = socketFactory(socketUrl.href);
      let settled = false;
      const timer = setTimeout(() => finish(null, new Error('Browser timed out')), 5000);
      function finish(result, error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.close();
        if (error) reject(error); else resolve(result);
      }
      socket.onopen = () => socket.send(JSON.stringify({ id: 1, method, params }));
      socket.onmessage = event => {
        try {
          const response = JSON.parse(event.data);
          if (response.id === 1) finish(response.result, response.error ? new Error(response.error.message) : null);
        } catch (error) { finish(null, error); }
      };
      socket.onerror = () => finish(null, new Error('Browser connection failed'));
    });
  }

  async function status() {
    if (!cdpUrl || (!loginUrl && !embedded)) return { state: 'unavailable', loginUrl: null };
    try {
      const { address, pages } = await targets();
      const page = kiePage(pages);
      if (!page) return { state: 'disconnected', loginUrl: loginUrl || null, embedded };
      const result = await command(page, address, 'Runtime.evaluate', {
        expression: "Boolean(document.cookie.split('; ').some(row => row.startsWith('authorization=')))",
        returnByValue: true,
      });
      return { state: result?.result?.value === true ? 'connected' : 'disconnected', loginUrl: loginUrl || null, embedded };
    } catch {
      return { state: 'unavailable', loginUrl: loginUrl || null, ...(embedded ? { embedded } : {}) };
    }
  }

  async function frame() {
    if (!embedded) throw new Error('Встроенный браузер не включён');
    const { address, pages } = await targets();
    const page = activePage(pages);
    if (!page) throw new Error('Страница браузера не открыта');
    const result = await command(page, address, 'Page.captureScreenshot', { format: 'jpeg', quality: 72, captureBeyondViewport: false });
    return { image: result.data };
  }

  async function input(action) {
    if (!embedded) throw new Error('Встроенный браузер не включён');
    const { address, pages } = await targets();
    const page = activePage(pages);
    if (!page) throw new Error('Страница браузера не открыта');
    if (action.type === 'click' && Number.isInteger(action.x) && Number.isInteger(action.y) && action.x >= 0 && action.x <= 1280 && action.y >= 0 && action.y <= 900) {
      await command(page, address, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: action.x, y: action.y, button: 'left', clickCount: 1 });
      await command(page, address, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: action.x, y: action.y, button: 'left', clickCount: 1 });
    } else if (action.type === 'text' && typeof action.text === 'string' && action.text.length > 0 && action.text.length <= 2048) {
      await command(page, address, 'Input.insertText', { text: action.text });
    } else if (action.type === 'key' && ['Enter', 'Tab', 'Backspace', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(action.key)) {
      const codes = { Enter: 13, Tab: 9, Backspace: 8, Escape: 27, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39 };
      await command(page, address, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: action.key, windowsVirtualKeyCode: codes[action.key] });
      await command(page, address, 'Input.dispatchKeyEvent', { type: 'keyUp', key: action.key, windowsVirtualKeyCode: codes[action.key] });
    } else if (action.type === 'scroll' && Number.isInteger(action.deltaY) && Math.abs(action.deltaY) <= 1200) {
      await command(page, address, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: 640, y: 450, deltaX: 0, deltaY: action.deltaY });
    } else if (action.type === 'reload') {
      await command(page, address, 'Page.reload');
    } else {
      throw new Error('Недопустимая команда браузера');
    }
  }

  return { status, frame, input };
}

module.exports = { createKieBrowserSession };
