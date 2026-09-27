const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function createKieEmbeddedBrowser({ dataDirectory, cdpUrl, idleMs = 5 * 60 * 1000,
  spawnImpl = spawn, fetchImpl = fetch } = {}) {
  let browser = null, display = null, starting = null, stopping = null, idleTimer = null, closed = false;
  const running = () => Boolean(browser && browser.exitCode === null && browser.signalCode === null);
  const clearIdle = () => { if (idleTimer) clearTimeout(idleTimer); idleTimer = null; };
  const touch = () => {
    clearIdle();
    if (!closed && idleMs > 0) {
      idleTimer = setTimeout(() => { void stop(); }, idleMs);
      idleTimer.unref?.();
    }
  };
  async function terminate(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => {
      const timeout = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
      child.once('exit', () => { clearTimeout(timeout); resolve(); });
      child.kill('SIGTERM');
    });
  }
  async function stop() {
    if (stopping) return stopping;
    clearIdle();
    stopping = (async () => {
      if (starting) await starting.catch(() => {});
      const oldBrowser = browser, oldDisplay = display;
      browser = null; display = null;
      await terminate(oldBrowser);
      await terminate(oldDisplay);
    })().finally(() => { stopping = null; });
    return stopping;
  }
  async function ensureActive() {
    if (closed) throw new Error('Браузер Kie остановлен');
    if (stopping) await stopping;
    if (!running() && (browser || display) && !starting) await stop();
    if (!running()) {
      if (!starting) starting = (async () => {
        const profile = path.resolve(dataDirectory, '..', 'kie-browser');
        await fs.mkdir(profile, { recursive: true, mode: 0o700 });
        display = spawnImpl('/usr/bin/Xvfb', [':99', '-screen', '0', '1280x900x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
        display.on('error', error => console.error('Kie display failed:', error.message));
        await pause(500);
        browser = spawnImpl('/usr/bin/chromium', [
          '--no-sandbox', '--disable-dev-shm-usage', '--disable-extensions',
          '--no-first-run', '--no-default-browser-check', '--remote-debugging-address=127.0.0.1',
          '--remote-debugging-port=9222', `--user-data-dir=${profile}`, '--window-size=1280,900',
          'https://kie.ai/api-key',
        ], { stdio: 'ignore', env: { ...process.env, DISPLAY: ':99' } });
        browser.on('error', error => console.error('Kie browser failed:', error.message));
        for (let attempt = 0; attempt < 60; attempt++) {
          if (!running()) break;
          try {
            const response = await fetchImpl(new URL('/json/list', cdpUrl), { signal: AbortSignal.timeout(1000) });
            if (response.ok) return;
          } catch {}
          await pause(250);
        }
        throw new Error('Браузер Kie не запустился');
      })().finally(() => { starting = null; });
      try { await starting; } catch (error) { await stop(); throw error; }
    } else if (starting) await starting;
    if (closed) throw new Error('Браузер Kie остановлен');
    touch();
  }
  async function close() { closed = true; await stop(); }
  return { ensureActive, touch, running, stop, close };
}

module.exports = { createKieEmbeddedBrowser };
