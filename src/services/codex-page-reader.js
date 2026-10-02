const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: pause } = require('node:timers/promises');
const { publicResultUrl, fetchPublicResult } = require('./public-web-fetch');
const { codexEnvironment } = require('./codex-runtime');
let active = 0;
const waiting = new Set();
async function acquire(signal) {
  signal.throwIfAborted();
  if (active < 2) active++;
  else await new Promise((resolve, reject) => {
    const entry = { resolve: () => { signal.removeEventListener('abort', abort); resolve(); } };
    const abort = () => { waiting.delete(entry); reject(new Error('Public page reader capacity timeout')); };
    waiting.add(entry); signal.addEventListener('abort', abort, { once: true });
  });
  return () => {
    const entry = waiting.values().next().value;
    if (entry) { waiting.delete(entry); entry.resolve(); }
    else active--;
  };
}

function pageUrl(value) {
  const url = publicResultUrl(value);
  if (url.port && url.port !== '443') throw new Error('Only public HTTPS pages on port 443 are supported');
  return url;
}

// A fresh, unauthenticated browser. Every network request is fulfilled by the
// DNS-pinned HTTPS reader; the browser itself has an unreachable network proxy.
async function readPublicPage(value, { signal, fetchPage = fetchPublicResult } = {}) {
  const target = pageUrl(value);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  let profile, release;
  let child, socket, childError, mainFrame, requests = 0, bytes = 0, mainStatus = null;
  const pending = new Map();
  const tasks = new Set();
  let id = 0;
  const alive = () => { if (childError) throw childError; if (controller.signal.aborted) throw new Error('Public page reading timed out or was cancelled'); };
  function command(method, params = {}) {
    alive();
    return new Promise((resolve, reject) => {
      const key = ++id;
      pending.set(key, { resolve, reject });
      try { socket.send(JSON.stringify({ id: key, method, params })); }
      catch (error) { pending.delete(key); reject(error); }
    });
  }
  const rejectPending = () => { for (const item of pending.values()) item.reject(new Error('Public page browser stopped')); pending.clear(); };
  controller.signal.addEventListener('abort', rejectPending);
  async function resource(event) {
    const fail = () => command('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' });
    try {
      if (++requests > 100 || event.request.method !== 'GET' || ['Image', 'Media', 'Font'].includes(event.resourceType)) return await fail();
      const url = pageUrl(event.request.url);
      // No credentials, cookies, arbitrary request headers, or writes are forwarded.
      const response = await fetchPage(url, controller.signal, undefined, undefined, { 'User-Agent': 'AI-Media-Public-Page-Reader', 'Accept-Encoding': 'identity' });
      if (event.resourceType === 'Document' && event.frameId === mainFrame) mainStatus = response.status;
      if (Number(response.headers.get('content-length')) > 4 * 1024 * 1024) { await response.body?.cancel(); return await fail(); }
      const chunks = []; let size = 0;
      if (response.body) for await (const chunk of response.body) {
        size += chunk.length; bytes += chunk.length;
        if (size > 4 * 1024 * 1024 || bytes > 12 * 1024 * 1024) throw new Error('Public page resource limit');
        chunks.push(Buffer.from(chunk));
      }
      const responseHeaders = [];
      for (const name of ['content-type', 'location', 'access-control-allow-origin']) {
        const header = response.headers.get(name);
        if (header) responseHeaders.push({ name, value: name === 'location' ? pageUrl(new URL(header, url)).href : header });
      }
      await command('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: response.status,
        responseHeaders, body: Buffer.concat(chunks).toString('base64') });
    } catch { await fail().catch(() => {}); }
  }
  try {
    release = await acquire(controller.signal);
    profile = await fs.mkdtemp(path.join(os.tmpdir(), 'media-page-'));
    alive();
    const browserEnv = codexEnvironment();
    delete browserEnv.CODEX_HOME;
    browserEnv.HOME = profile;
    browserEnv.XDG_CONFIG_HOME = path.join(profile, 'config');
    browserEnv.XDG_CACHE_HOME = path.join(profile, 'cache');
    child = spawn('/usr/bin/chromium', ['--headless', '--no-sandbox', '--disable-dev-shm-usage', '--disable-extensions',
      '--disable-background-networking', '--disable-component-update', '--no-first-run', '--no-default-browser-check',
      '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
    { env: browserEnv, stdio: 'ignore', detached: true });
    child.on('error', error => { childError = error; controller.abort(); });
    child.on('exit', (code, signal) => { childError = new Error(`Public page browser exited (${code ?? signal})`); controller.abort(); });
    let port;
    while (!port) {
      alive();
      port = await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').then(text => Number(text.split('\n')[0]), () => null);
      if (!port) await pause(100, undefined, { signal: controller.signal });
    }
    const tabs = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: controller.signal }).then(r => r.json());
    const tab = tabs.find(item => item.type === 'page');
    if (!tab) throw new Error('Public page browser did not create a tab');
    socket = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(new Error('Public page browser connection failed'));
      controller.signal.addEventListener('abort', () => reject(new Error('Public page reading cancelled')), { once: true });
    });
    socket.onclose = rejectPending;
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const item = pending.get(message.id);
        if (item) { pending.delete(message.id); if (message.error) item.reject(new Error('Public page browser command failed')); else item.resolve(message.result); }
      } else if (message.method === 'Fetch.requestPaused') {
        const task = resource(message.params);
        tasks.add(task); void task.finally(() => tasks.delete(task)).catch(() => {});
      }
    };
    await command('Network.enable');
    await command('Network.setBypassServiceWorker', { bypass: true });
    await command('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    mainFrame = (await command('Page.getFrameTree')).frameTree.frame.id;
    await command('Page.navigate', { url: target.href });
    let snapshot, previous = '', stable = 0;
    for (let attempt = 0; attempt < 30; attempt++) {
      await pause(500, undefined, { signal: controller.signal });
      const result = await command('Runtime.evaluate', {
        expression: `JSON.stringify({url:location.href,title:document.title,text:(document.body?.innerText||'').slice(0,18000),links:Array.from(document.querySelectorAll('a[href]')).filter(a=>a.innerText.trim()).slice(0,40).map(a=>({text:a.innerText.trim().slice(0,120),url:a.href}))})`,
        returnByValue: true,
      });
      snapshot = JSON.parse(result.result.value);
      stable = snapshot.text === previous ? stable + 1 : 0; previous = snapshot.text;
      if (snapshot.text.length > 80 && stable >= 3 && !/Подготавливаем рабочее пространство|Загружаем необходимые данные/.test(snapshot.text)) break;
    }
    if (!snapshot || mainStatus === null) throw new Error('Public page did not load');
    pageUrl(snapshot.url);
    return { ...snapshot, status: mainStatus, scope: 'Public page rendered with JavaScript, without login or user interaction. Links were observed, not visited.' };
  } finally {
    controller.abort(); clearTimeout(timeout); signal?.removeEventListener('abort', abort);
    socket?.close(); rejectPending();
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      await exited;
    }
    await Promise.allSettled([...tasks]);
    try { if (profile) await fs.rm(profile, { recursive: true, force: true }); }
    finally { release?.(); }
  }
}
module.exports = { readPublicPage, pageUrl };
