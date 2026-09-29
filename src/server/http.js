const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { ROLES, isAdminRole, assertAdminRole } = require('../auth/roles');
const { createKieBrowserSession } = require('../services/kie-browser-session');
const { handleCommerceRequest } = require('./routes/commerce');
const { handleWorkspaceRequest } = require('./routes/workspace');
const { handleGenerationRequest } = require('./routes/generation');
const { handleAdminRequest } = require('./routes/admin');
const { handleSourceUpload, handleContentRead } = require('./routes/content');
const { buildInfo } = require('./build-info');
const { checkDatabase, transientConnection } = require('../database/database');
const trace = require('../generation-log');
const systemErrors = require('../system-errors');
const sharedFiles = new Set(['renderer.js', 'provider-errors.js', 'styles.css', 'ru.js', 'templates-ui.js', 'source-preview.js', 'file-drop.js', 'choice-buttons.js', 'structured-fields.js', 'drafts.js', 'costs.js', 'tariff-snapshot.js', 'price-audit.js', 'duration.js', 'costs-ui.js']);
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' };
const publicAssets = new Set(['web.js', 'web.css', 'account-menu.js', 'native-costs.js', 'admin.js', 'codex-models.js']);
const publicPageAssets = new Set(['brand-logo.png', 'landing.css', 'landing.js', 'legal.css', 'login.js', 'max-wait.js', 'max-confirm.js', 'web.css', 'version.js', 'theme.css', 'theme.js', 'localization-en.js', 'localization-runtime.js']);
const landingModelIcons = new Set([
  'openai.svg', 'google.svg', 'bytedance.svg', 'kling.svg', 'grok.svg', 'flux.svg',
  'hailuo.svg', 'minimax.svg', 'ideogram.svg', 'qwen.svg', 'recraft.svg', 'topaz.svg',
  'runway.svg', 'pixverse.svg', 'happyhorse.svg', 'volcengine.svg',
]);
const legalPages = new Map([
  ['/legal/terms', 'terms.html'],
  ['/legal/privacy', 'privacy.html'],
  ['/legal/personal-data-consent', 'personal-data-consent.html'],
  ['/legal/offer', 'offer.html'],
]);
const vueAppPrefix = '/app';
const retryableReadRpc = new Set(['nativeQuote', 'diagnoseProvider']);
const missingMediaPlaceholder = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540" role="img" aria-labelledby="title description">
  <title id="title">Файл недоступен</title>
  <desc id="description">Медиафайл отсутствует в хранилище</desc>
  <rect width="960" height="540" fill="#111110"/>
  <rect x="330" y="125" width="300" height="220" rx="24" fill="#181816" stroke="#403d38" stroke-width="4"/>
  <path d="M380 300l82-82 58 58 42-42 48 66H380z" fill="#35322e"/>
  <circle cx="548" cy="196" r="24" fill="#ff5a2f" opacity=".72"/>
  <path d="M447 154h66M480 121v66" stroke="#a09c95" stroke-width="10" stroke-linecap="round" transform="rotate(45 480 154)"/>
  <text x="480" y="402" fill="#f5f1e9" font-family="Arial, sans-serif" font-size="30" font-weight="700" text-anchor="middle">Файл недоступен</text>
  <text x="480" y="442" fill="#a09c95" font-family="Arial, sans-serif" font-size="20" text-anchor="middle">Он отсутствует в хранилище</text>
</svg>`);

function missingMedia(error) {
  return error?.code === 'ENOENT'
    || error?.name === 'NoSuchKey'
    || error?.name === 'NotFound'
    || error?.$metadata?.httpStatusCode === 404;
}

function sendMissingMedia(req, res) {
  res.writeHead(200, {
    ...headers,
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Content-Length': missingMediaPlaceholder.length,
    'Cache-Control': 'no-store',
    'X-Media-Placeholder': 'missing',
  });
  res.end(req.method === 'HEAD' ? '' : missingMediaPlaceholder);
}

async function sendMedia(req, res, action) {
  try { return await action(); }
  catch (error) {
    if (missingMedia(error)) return sendMissingMedia(req, res);
    throw error;
  }
}

function temporaryConnectionFailure(error) {
  return transientConnection(error);
}
async function withTransientConnectionRetry(action, retry) {
  for (let attempt = 0; ; attempt++) {
    try { return await action(); }
    catch (error) {
      if (!retry || attempt >= 2 || !temporaryConnectionFailure(error)) throw error;
      await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
}
async function assetUser(auth, req, retry) {
  return withTransientConnectionRetry(() => auth.user(req), retry);
}
const headers = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' https: data: blob:; media-src 'self' https: blob:; connect-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'"
};
async function readBody(req, limit) {
  if (Number(req.headers['content-length']) > limit) throw new Error('Файл или запрос слишком большой');
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error('Файл или запрос слишком большой'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
function json(res, status, value, extraHeaders = {}) {
  res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(JSON.stringify(value));
}
async function sendFile(req, res, filename, type, attachment = false, extraHeaders = {}) {
  const stat = await fs.stat(filename);
  if (!stat.isFile()) throw new Error('Файл не найден');
  let start = 0, end = stat.size - 1, status = 200;
  if (req.headers.range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
    if (!match) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return; }
    start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), end) : end;
    if (start > end || start >= stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return; }
    status = 206;
  }
  const contentType = type || mime[path.extname(filename).toLowerCase()] || 'application/octet-stream';
  const responseHeaders = {
    ...headers, 'Content-Type': contentType, 'Content-Length': stat.size ? end - start + 1 : 0,
    'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
    ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${stat.size}` } : {}),
    ...(attachment ? { 'Content-Disposition': `attachment; filename="${path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_')}"` } : {}),
    ...extraHeaders
  };
  if (responseHeaders['X-Frame-Options'] === null) delete responseHeaders['X-Frame-Options'];
  res.writeHead(status, responseHeaders);
  if (req.method === 'HEAD' || !stat.size) { res.end(); return; }
  const stream = createReadStream(filename, { start, end });
  stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
}
function forwardToExecutor(req, res, executorUrl, executorPublicOrigin, publicOrigin) {
  // Only origin-form paths may be proxied. URL() otherwise accepts //host/path
  // and silently replaces the trusted executor authority.
  if (typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.startsWith('//')
    || /\\|%2f|%5c/i.test(req.url.split('?')[0])) {
    return Promise.resolve(json(res, 400, { error: 'Недопустимый адрес запроса' }));
  }
  const executor = new URL(executorUrl);
  const target = new URL(req.url, executor);
  if (target.origin !== executor.origin) return Promise.resolve(json(res, 400, { error: 'Недопустимый адрес запроса' }));
  const headers = { ...req.headers, host: new URL(executorPublicOrigin).host };
  const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection']);
  for (const name of String(headers.connection || '').split(',')) hopHeaders.add(name.trim().toLowerCase());
  for (const name of hopHeaders) delete headers[name];
  delete headers['x-forwarded-host']; delete headers['x-forwarded-proto']; delete headers['x-forwarded-for'];
  if (headers.origin === `http://${req.headers.host}`) headers.origin = executorPublicOrigin;
  return new Promise(resolve => {
    const upstream = (target.protocol === 'https:' ? https : http).request(target, { method: req.method, headers }, response => {
      const responseHeaders = { ...response.headers };
      if (publicOrigin && responseHeaders.location) {
        try {
          const location = new URL(responseHeaders.location);
          if (location.origin === executorPublicOrigin) responseHeaders.location = publicOrigin + location.pathname + location.search + location.hash;
        } catch {}
      }
      res.writeHead(response.statusCode, responseHeaders);
      response.pipe(res);
      response.once('end', resolve);
      response.once('error', () => { res.destroy(); resolve(); });
    });
    upstream.once('error', () => {
      if (!res.headersSent) json(res, 503, { error: 'Исполнитель задач недоступен' });
      else res.destroy();
      resolve();
    });
    upstream.setTimeout(30000, () => upstream.destroy(new Error('Executor timeout')));
    res.once('close', () => upstream.destroy());
    req.pipe(upstream);
  });
}
async function sendStored(req, res, storage, file, attachment = false) {
  if (!storage || !file?.storageKey) throw new Error('S3-хранилище не подключено');
  const stat = await storage.head(file.storageKey);
  let start = 0, end = stat.size - 1, status = 200, range = '';
  if (req.headers.range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
    if (!match) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return; }
    start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), end) : end;
    if (start > end || start >= stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return; }
    status = 206; range = `bytes=${start}-${end}`;
  }
  const result = req.method === 'HEAD' || !stat.size ? null : await storage.stream(file.storageKey, range);
  res.writeHead(status, {
    ...headers, 'Content-Type': file.type || stat.type, 'Content-Length': stat.size ? end - start + 1 : 0,
    'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
    ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${stat.size}` } : {}),
    ...(attachment ? { 'Content-Disposition': `attachment; filename="${String(file.name || 'download').replace(/[^a-zA-Z0-9._-]/g, '_')}"` } : {}),
  });
  if (req.method === 'HEAD' || !stat.size) { res.end(); return; }
  result.body.on('error', () => res.destroy()); res.on('close', () => result.body.destroy()); result.body.pipe(res);
}
function createHttpServer({ config, service: legacyService, auth, accounts, readiness, databaseAvailability, databaseWaitMs = 10000, telegramStatus = () => ({ enabled: false }), telegram = null, storage = null, payments = null, commerce = null, generationServices = null, kieBrowserControl = null, vueRoot = process.env.MEDIA_VUE_ROOT || path.join(config.root, 'public', 'vue'), recordSystemEvent = systemErrors.record }) {
  let uploadBytesInFlight = 0;
  const release = buildInfo(config.root);
  const kieBrowserSession = createKieBrowserSession(config.kieBrowser);
  let codex = generationServices?.codex || null;
  let codexProvider = generationServices?.codexProvider || null;
  let routerAi = generationServices?.routerAi || null;
  let apimart = generationServices?.apimart || null;
  let costRouter = generationServices?.costRouter || null;
  let routerAiModels = generationServices?.routerAiModels || null;
  let routerAiStatus = generationServices?.routerAiStatus || null;
  const connections = new Set();
  const eventLoopBaseline = performance.eventLoopUtilization();
  let loginWindow = Date.now(), loginRequests = 0;
  const server = http.createServer(async (req, res) => {
    try {
      if (typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.startsWith('//')
        || /\\|%2f|%5c/i.test(req.url.split('?')[0])) return json(res, 400, { error: 'Недопустимый адрес запроса' });
      const localPort = server.address().port;
      const allowedHosts = new Set([`127.0.0.1:${localPort}`, `localhost:${localPort}`, `[::1]:${localPort}`]);
      if (config.publicOrigin) allowedHosts.add(new URL(config.publicOrigin).host);
      if (!allowedHosts.has(req.headers.host)) return json(res, 403, { error: 'Недопустимый адрес сервиса' });
      const url = new URL(req.url, `http://${req.headers.host}`);
      const normalizedPath = url.pathname.length > 1 ? url.pathname.replace(/\/$/, '') : url.pathname;
      if (req.method === 'POST' && url.pathname === `/api/payments/webhooks/yookassa/${config.payments?.environment || 'test'}`) {
        if (config.replicaRole === 'web') return forwardToExecutor(req, res, config.executorUrl, config.executorPublicOrigin, config.publicOrigin);
        if (!payments || config.payments?.provider !== 'yookassa') return json(res, 404, { error: 'Не найдено' });
        if (!(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'Ожидается JSON' });
        const body = JSON.parse((await readBody(req, 256 * 1024)).toString('utf8'));
        await payments.webhook(body);
        return json(res, 200, { ok: true });
      }
      const legalPage = legalPages.get(normalizedPath);
      const rpcMatch = req.method === 'POST' ? /^\/api\/rpc\/([a-zA-Z]+)$/.exec(url.pathname) : null;
      const retryReadOnlyRpc = Boolean(rpcMatch && retryableReadRpc.has(rpcMatch[1]));
      if (auth && config.port !== 0 && req.method === 'GET' && /^\/auth\/[a-z][a-z0-9_-]*\/start$/.test(url.pathname) && req.headers.host !== new URL(config.auth.origin).host) {
        res.writeHead(302, { ...headers, Location: config.auth.origin + url.pathname + url.search, 'Cache-Control': 'no-store' }); res.end(); return;
      }
      const sameOrigin = !req.headers.origin || req.headers.origin === `http://${req.headers.host}` || (config.publicOrigin && req.headers.origin === config.publicOrigin);
      const callbackProvider = /^\/auth\/([a-z][a-z0-9_-]*)\/callback$/.exec(url.pathname)?.[1];
      const oauthCallback = req.method === 'GET' && auth?.providers().some(provider => !['email', 'max'].includes(provider.id) && provider.id === callbackProvider);
      const emailVerify = req.method === 'GET' && url.pathname === '/auth/email/verify' && Boolean(auth?.email);
      const maxStart = req.method === 'GET' && url.pathname === '/auth/max/start' && Boolean(auth?.max);
      const maxPage = ['GET', 'HEAD'].includes(req.method) && ['/auth/max/wait', '/auth/max/confirm'].includes(url.pathname) && Boolean(auth?.max);
      const oauthStartProvider = /^\/auth\/([a-z][a-z0-9_-]*)\/start$/.exec(url.pathname)?.[1];
      const oauthStart = req.method === 'GET' && auth?.providers().some(provider => !['email', 'max'].includes(provider.id) && provider.id === oauthStartProvider);
      const pageNavigation = ['GET', 'HEAD'].includes(req.method)
        && (['/', '/index.html', '/app', '/app/', '/legacy', '/legacy/', '/login'].includes(url.pathname) || Boolean(legalPage))
        && req.headers['sec-fetch-mode'] === 'navigate'
        && req.headers['sec-fetch-dest'] === 'document';
      const allowedTopLevelNavigation = pageNavigation || maxPage || (oauthStart && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document')
        || (maxStart && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document');
      if (!allowedTopLevelNavigation && !oauthCallback && !emailVerify && (!sameOrigin || req.headers['sec-fetch-site'] === 'cross-site')) return json(res, 403, { error: 'Запрос с другого сайта запрещён' });
      if (config.replicaRole === 'web' && (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)
        || /^\/api\/(?:codex|routerai|apimart|auto|admin)\//.test(url.pathname)
        || url.pathname === '/api/startup' || url.pathname === '/api/account/telegram')) {
        return forwardToExecutor(req, res, config.executorUrl, config.executorPublicOrigin, config.publicOrigin);
      }
      const redirect = (location, cookies) => { res.writeHead(302, { ...headers, Location: location, 'Cache-Control': 'no-store', ...(cookies ? { 'Set-Cookie': cookies } : {}) }); res.end(); };
      const shared = /^\/shared\/([^/]+)$/.exec(url.pathname);
      const landingModelIcon = /^\/landing-model-icons\/([a-z0-9-]+\.svg)$/.exec(url.pathname)?.[1];
      const isLanding = ['/', '/index.html'].includes(url.pathname);
      const isVueApp = url.pathname === vueAppPrefix || url.pathname === `${vueAppPrefix}/` || url.pathname.startsWith(`${vueAppPrefix}/`);
      const isVuePublicAsset = isVueApp && Boolean(path.extname(url.pathname));
      const isLegacyApp = ['/legacy', '/legacy/', '/legacy/index.html'].includes(url.pathname);
      const isAsset = ['GET', 'HEAD'].includes(req.method)
        && (isLanding || Boolean(legalPage) || publicPageAssets.has(url.pathname.slice(1)) || landingModelIcons.has(landingModelIcon) || sharedFiles.has(shared?.[1]) || publicAssets.has(url.pathname.slice(1)) || url.pathname === '/codex-models.json' || /^\/api\/content\/[a-f0-9-]{36}$/.test(url.pathname) || isVueApp || isLegacyApp);
      const sendVueApplication = async user => {
        const root = vueRoot;
        const relative = isLanding || url.pathname === vueAppPrefix || url.pathname === `${vueAppPrefix}/` ? 'index.html' : url.pathname.slice(`${vueAppPrefix}/`.length);
        if (!relative || relative.split('/').includes('..')) return json(res, 404, { error: 'Не найдено' });
        const sendVueIndex = async () => {
          let html = await fs.readFile(path.join(root, 'index.html'), 'utf8');
          const starterStatus = user && accounts?.starterPack ? await accounts.starterPack.status(user.id, user.role) : null;
          html = html.replace('<head>', `<head><meta name="account-id" content="${user?.id || 'pending'}"><meta name="account-role" content="${user?.role || 'pending'}"><meta name="account-model-access" content="${starterStatus?.modelAccess || 'pending'}">`);
          if (user && req.method === 'GET' && (url.pathname === vueAppPrefix || url.pathname === `${vueAppPrefix}/`)) {
            recordSystemEvent('studio', 'chat.page.served', 'Chat page served', {
              accountId: user.id, asset: html.match(/\/app\/assets\/[^"']+\.js/)?.[0] || null, build: release.build,
            });
          }
          res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(req.method === 'HEAD' ? '' : html);
        };
        if (relative === 'index.html') return await sendVueIndex();
        const filename = path.join(root, relative);
        try { return await sendFile(req, res, filename); }
        catch (error) {
          if (path.extname(relative)) throw error;
          return await sendVueIndex();
        }
      };
      if (req.method === 'GET' && url.pathname === '/api/startup') {
        // Page navigation reuses the process-wide pool. This is only a liveness
        // probe; pg reconnects the pool when the previous connection was lost.
        let database = accounts ? await checkDatabase(accounts.pool, { diagnostics: false }) : (databaseAvailability?.snapshot() || readiness?.database || { state: config.auth.enabled ? 'connecting' : 'disabled' });
        let startupUser = config.auth.enabled ? null : { id: 'local', role: ROLES.ADMIN, name: 'Владелец' };
        if (auth && database.state === 'connected') {
          try { startupUser = await assetUser(auth, req, true); }
          catch (error) {
            if (!temporaryConnectionFailure(error)) throw error;
            database = { state: 'unavailable', code: error.code || 'CONNECTION_TIMEOUT' };
          }
        }
        return json(res, 200, {
          database,
          provider: readiness?.provider || { state: 'idle' },
          authenticated: config.auth.enabled ? Boolean(startupUser) : true,
          account: startupUser ? { id: startupUser.id, role: startupUser.role,
            starterPack: accounts?.starterPack ? await accounts.starterPack.status(startupUser.id, startupUser.role) : null } : null,
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/health') {
        const database = accounts ? await checkDatabase(accounts.pool) : (databaseAvailability?.snapshot() || readiness?.database || { state: config.auth.enabled ? 'connecting' : 'disabled' });
        const status = ['connected', 'disabled'].includes(database.state) ? 200 : 503;
        const memory = process.memoryUsage();
        return json(res, status, { ok: status === 200, version: release.version, build: release.build, database,
          generationConfigured: config.replicaRole === 'web' ? null : Boolean(legacyService.configured?.()),
          runtime: { replicaRole: config.replicaRole || 'single', rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, externalBytes: memory.external,
            sseConnections: connections.size, eventLoopUtilization: Number(performance.eventLoopUtilization(eventLoopBaseline).utilization.toFixed(4)) },
          payments: { enabled: Boolean(payments), salesEnabled: Boolean(commerce && config.commerce?.salesEnabled), environment: config.payments?.environment || 'test', provider: config.payments?.provider || null }, telegram: telegramStatus() });
      }
      if (req.method === 'GET' && url.pathname === '/api/version') return json(res, 200, release);
      if (auth && req.method === 'GET' && url.pathname === '/auth/providers') return json(res, 200, { result: auth.providerChoices() });
      if (auth?.max && maxStart) {
        if (Date.now() - loginWindow > 60000) { loginWindow = Date.now(); loginRequests = 0; }
        if (++loginRequests > 120) return json(res, 429, { error: 'Слишком много попыток входа. Повторите позже.' });
        const flow = await auth.max.begin();
        return redirect(flow.location, flow.cookie);
      }
      if (auth?.max && maxPage) {
        const file = url.pathname.endsWith('/wait') ? 'max-wait.html' : 'max-confirm.html';
        const frameHeaders = file === 'max-confirm.html' ? { 'X-Frame-Options': null,
          'Content-Security-Policy': headers['Content-Security-Policy'].replace("frame-ancestors 'none'", 'frame-ancestors https://max.ru https://*.max.ru') } : {};
        return sendFile(req, res, path.join(config.root, 'public', file), undefined, false, frameHeaders);
      }
      if (auth?.max && req.method === 'GET' && url.pathname === '/auth/max/link') {
        try { return json(res, 200, { url: await auth.max.link(req) }); }
        catch (error) { return json(res, 400, { error: error.message }); }
      }
      if (auth?.max && req.method === 'GET' && url.pathname === '/auth/max/status') {
        try { const result = await auth.max.status(req); return json(res, 200, { ready: result.ready }, result.cookie ? { 'Set-Cookie': result.cookie } : {}); }
        catch (error) { return json(res, 400, { error: error.message }); }
      }
      if (auth?.max && req.method === 'POST' && url.pathname === '/auth/max/confirm') {
        if (Date.now() - loginWindow > 60000) { loginWindow = Date.now(); loginRequests = 0; }
        if (++loginRequests > 120) return json(res, 429, { error: 'Слишком много попыток входа. Повторите позже.' });
        if (!String(req.headers['content-type'] || '').startsWith('application/json') || !req.headers.origin || !sameOrigin) return json(res, 403, { error: 'Запрос с другого сайта запрещён' });
        try { const body = JSON.parse((await readBody(req, 10000)).toString('utf8')); await auth.max.confirm(body.initData); return json(res, 200, { ok: true }); }
        catch (error) { return json(res, 400, { error: error.message || 'Вход MAX не выполнен' }); }
      }
      if (auth?.email && emailVerify) {
        try { return redirect('/app', await auth.email.verify(req, url.searchParams.get('token'))); }
        catch { return redirect('/login?error=verify'); }
      }
      if (auth?.email && req.method === 'POST' && /^\/auth\/email\/(register|login|forgot|reset)$/.test(url.pathname)) {
        if (Date.now() - loginWindow > 60000) { loginWindow = Date.now(); loginRequests = 0; }
        if (++loginRequests > 120) return json(res, 429, { error: 'Слишком много попыток входа. Повторите позже.' });
        if (!String(req.headers['content-type'] || '').startsWith('application/json') || !req.headers.origin || !sameOrigin) return json(res, 403, { error: 'Запрос с другого сайта запрещён' });
        try {
          const body = JSON.parse((await readBody(req, 2048)).toString('utf8'));
          if (url.pathname.endsWith('/register')) { await auth.email.register(body.email, body.password); return json(res, 200, { ok: true }); }
          if (url.pathname.endsWith('/forgot')) { await auth.email.forgot(body.email); return json(res, 200, { ok: true }); }
          if (url.pathname.endsWith('/reset')) { await auth.email.reset(body.token, body.password); return json(res, 200, { ok: true }); }
          const session = await auth.email.login(req, body.email, body.password);
          return json(res, 200, { ok: true }, { 'Set-Cookie': session });
        } catch (error) { return json(res, error.message === 'Неверный email или пароль' ? 401 : 400, { error: error.message || 'Вход не выполнен' }); }
      }
      const authRoute = /^\/auth\/([a-z][a-z0-9_-]*)\/(start|callback)$/.exec(url.pathname);
      if (auth && req.method === 'GET' && authRoute && !['email', 'max'].includes(authRoute[1])) {
        if (Date.now() - loginWindow > 60000) { loginWindow = Date.now(); loginRequests = 0; }
        if (++loginRequests > 120) return json(res, 429, { error: 'Слишком много попыток входа. Повторите позже.' });
        if (authRoute[2] === 'start') { const result = await auth.begin(authRoute[1]); return redirect(result.location, result.cookie); }
        try { return redirect('/app', await auth.finish(req, authRoute[1], url.searchParams)); }
        catch { return redirect('/login?error=oauth'); }
      }
      if (['GET', 'HEAD'].includes(req.method) && (Boolean(legalPage) || publicPageAssets.has(url.pathname.slice(1)) || url.pathname === '/login')) {
        const publicFile = legalPage ? path.join('legal', legalPage) : url.pathname === '/login' ? 'login.html' : url.pathname.slice(1);
        return await sendFile(req, res, path.join(config.root, 'public', publicFile));
      }
      if (['GET', 'HEAD'].includes(req.method) && landingModelIcons.has(landingModelIcon)) {
        return await sendFile(req, res, path.join(vueRoot, 'model-icons', landingModelIcon));
      }
      if (['GET', 'HEAD'].includes(req.method) && isVuePublicAsset) return await sendVueApplication(null);
      if (config.auth.enabled && !auth && (isLanding || isVueApp) && ['GET', 'HEAD'].includes(req.method)) return await sendVueApplication(null);
      if (config.auth.enabled && !auth && retryReadOnlyRpc) await databaseAvailability?.waitUntilAvailable(databaseWaitMs);
      if (config.auth.enabled && !auth) return json(res, 503, { error: 'Подключаемся к базе данных. Повторите через несколько секунд.', code: 'DATABASE_UNAVAILABLE', retryable: true });
      // Retry only the read-only session lookup for assets, never account/API writes.
      const user = auth ? await assetUser(auth, req, isAsset || retryReadOnlyRpc) : { id: 'local', role: ROLES.ADMIN, name: 'Владелец' };
      if (!user) {
        if (isLanding) return await sendVueApplication(null);
        if (isVueApp || isLegacyApp) return redirect('/login');
        return json(res, 401, { error: 'Необходим вход в аккаунт' });
      }
      if (auth && req.method === 'POST' && req.headers['x-media-user'] !== user.id) return json(res, 409, { error: 'Аккаунт изменился. Перезагрузите страницу.' });
      if (url.pathname === '/api/account/telegram') {
        if (!config.auth.enabled || !telegram || req.method !== 'GET') return json(res, 404, { error: 'Метод не найден' });
        return json(res, 200, { result: await telegram.linkStatus(user.id) });
      }
      if (url.pathname === '/api/account/telegram/link') {
        if (!config.auth.enabled || !telegram || req.method !== 'POST' || req.headers['x-media-client'] !== 'web') return json(res, 404, { error: 'Метод не найден' });
        return json(res, 200, { result: await telegram.createLink(user.id) });
      }
      if (url.pathname === '/api/account/telegram/unlink') {
        if (!config.auth.enabled || !telegram || req.method !== 'POST' || req.headers['x-media-client'] !== 'web') return json(res, 404, { error: 'Метод не найден' });
        return json(res, 200, { result: await telegram.unlink(user.id) });
      }
      if (/^\/api\/(?:codex|apimart|routerai|auto)\//.test(url.pathname)) {
        return await handleGenerationRequest({ req, res, url, user, accounts, codex, codexProvider, routerAi, apimart, costRouter, routerAiModels, headers,
          send: (status, body) => json(res, status, body), readBody: limit => readBody(req, limit),
          sendMedia: fn => sendMedia(req, res, fn),
          sendStored: (file, attachment) => sendStored(req, res, storage, file, attachment),
          sendFile: (file, type, attachment) => sendFile(req, res, file, type, attachment) });
      }
      if (req.method === 'POST' && url.pathname === '/auth/logout') {
        if (req.headers['x-media-client'] !== 'web') return json(res, 403, { error: 'Доступ запрещён' });
        res.setHeader('Set-Cookie', auth ? await auth.logout(req) : '');
        for (const connection of connections) if (connection.accountId === user.id) connection.end();
        return json(res, 200, { result: true });
      }
      if ((isLanding || isVueApp) && ['GET', 'HEAD'].includes(req.method)) {
        return await sendVueApplication(user);
      }
      if (req.method === 'GET' && url.pathname === '/api/account') return json(res, 200, { result: { ...user, identities: auth ? await auth.identities(user.id) : [], wallet: accounts ? await accounts.wallet.get(user.id) : null,
        starterPack: accounts?.starterPack ? await accounts.starterPack.status(user.id, user.role) : null } });
      if (accounts && url.pathname.startsWith('/api/commerce/')) {
        return handleCommerceRequest({ req, url, user, config, commerce,
          send: (status, body) => json(res, status, body),
          readJson: async limit => JSON.parse((await readBody(req, limit)).toString('utf8')) });
      }
      if (accounts && req.method === 'POST' && url.pathname === '/api/account/profile' && req.headers['x-media-client'] === 'web') {
        const body = JSON.parse((await readBody(req, 4096)).toString('utf8'));
        return json(res, 200, { result: await accounts.updateProfile(user.id, body.name) });
      }
      if (accounts && ((req.method === 'GET' && ['/api/workspace/history', '/api/workspace/sync'].includes(url.pathname))
        || /^\/api\/(projects|chats)(?:\/[^/]+(?:\/(archive|restore|move))?)?$/.test(url.pathname))) {
        return await handleWorkspaceRequest({ req, url, user, accounts,
          send: (status, body) => json(res, status, body),
          readBody: limit => readBody(req, limit), recordSystemEvent });
      }
      if (url.pathname.startsWith('/api/admin/')) {
        return await handleAdminRequest({ req, url, user, accounts, config, kieBrowserControl, kieBrowserSession, routerAiStatus, apimart,
          send: (status, body) => json(res, status, body), readBody: limit => readBody(req, limit) });
      }
      // An admin can explicitly select a workspace; ordinary users cannot supply a tenant.
      const selected = req.headers['x-media-account'] || url.searchParams.get('account') || undefined;
      // Static scripts need authentication, not account storage/queue initialization.
      const service = accounts && url.pathname.startsWith('/api/')
        ? await withTransientConnectionRetry(() => accounts.scope(user, selected), retryReadOnlyRpc)
        : legacyService;
      if (req.method === 'POST') {
        if (req.headers['x-media-client'] !== 'web') return json(res, 403, { error: 'Недопустимый источник запроса' });
        if (url.pathname === '/api/source') {
          return await handleSourceUpload({ req, url, user, accounts, selected, service, config,
            send: (status, body) => json(res, status, body),
            reserveUpload: async (reservation, action) => {
              if (uploadBytesInFlight + reservation > (config.uploadInFlightLimit ?? 256 * 1024 * 1024))
                return json(res, 429, { error: 'Слишком много одновременных загрузок' });
              uploadBytesInFlight += reservation;
              try { return await action(); } finally { uploadBytesInFlight -= reservation; }
            } });
        }
        const match = rpcMatch;
        if (!match) return json(res, 404, { error: 'Метод не найден' });
        if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new Error('Ожидается JSON');
        const args = JSON.parse((await readBody(req, 4 * 1024 * 1024)).toString('utf8'));
        if (!Array.isArray(args) || args.length > 5) throw new Error('Некорректные аргументы');
        const result = await service.dispatch(match[1], args);
        return json(res, 200, { result: result ?? null });
      }
      if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Метод не поддерживается' });
      if (url.pathname === '/codex-models.json') return await sendFile(req, res, path.join(config.root, 'config/codex-models.json'), 'application/json; charset=utf-8');
      if (url.pathname === '/api/events') {
        const maxConnections = config.sse?.maxConnections ?? 100;
        const maxPerAccount = config.sse?.maxPerAccount ?? 8;
        if (connections.size >= maxConnections || [...connections].filter(connection => connection.accountId === user.id).length >= maxPerAccount)
          return json(res, 429, { error: 'Слишком много открытых вкладок' });
        res.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write('data: ready\n\n'); res.accountId = user.id; connections.add(res);
        const writeEvent = value => { if (res.destroyed) return; if (res.writableLength >= 65536) { res.end(); return; } res.write(value); };
        let changedTimer = null;
        const notify = () => { if (!changedTimer) changedTimer = setTimeout(() => { changedTimer = null; writeEvent('data: changed\n\n'); }, 50); };
        const reset = () => { if (changedTimer) { clearTimeout(changedTimer); changedTimer = null; } writeEvent('data: reset\n\n'); };
        service.events.on('changed', notify);
        service.events.on('reset', reset);
        const heartbeat = setInterval(async () => { try { if (auth && (await auth.user(req))?.id !== user.id) { res.end(); return; } writeEvent(': keepalive\n\n'); } catch { res.end(); } }, 15000);
        res.on('close', () => { clearInterval(heartbeat); if (changedTimer) clearTimeout(changedTimer); connections.delete(res); service.events.off('changed', notify); service.events.off('reset', reset); });
        return;
      }
      if (/^\/api\/(?:sources\/[a-f0-9]{64}|results\/[a-f0-9-]{36}\/\d+|content\/[a-f0-9-]{36})$/.test(url.pathname)) {
        return await handleContentRead({ url, user, selected, accounts, service,
          sendMedia: fn => sendMedia(req, res, fn),
          sendStored: (file, attachment) => sendStored(req, res, storage, file, attachment),
          sendFile: (file, type, attachment) => sendFile(req, res, file, type, attachment) });
      }
      if (shared && ['tariff-snapshot.js', 'costs.js', 'costs-ui.js', 'price-audit.js'].includes(shared[1])) assertAdminRole(user.role);
      if (shared && sharedFiles.has(shared[1])) return await sendFile(req, res, path.join(config.root, 'src', shared[1]));
      const publicFile = isLegacyApp ? 'index.html' : url.pathname.slice(1);
      if (publicFile === 'index.html') {
        let html = await fs.readFile(path.join(config.root, 'public/index.html'), 'utf8');
        html = html.replace('<head>', `<head><meta name="account-id" content="${user.id}"><meta name="account-role" content="${user.role}">`);
        if (!isAdminRole(user.role)) {
          html = html.replace(/<!-- provider-settings:start -->[\s\S]*?<!-- provider-settings:end -->/, '');
          html = html.replace(/<details id="officialTariff">[\s\S]*?<\/details>/, '');
          html = html.replace(/<script src="\/shared\/(tariff-snapshot|costs|price-audit|costs-ui)\.js"><\/script>/g, '');
          html = html.replace('<script src="/shared/renderer.js">', '<script src="/native-costs.js"></script><script src="/shared/renderer.js">');
          html = html.replace('<body>', '<body class="native-account">');
        }
        res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(req.method === 'HEAD' ? '' : html);
      }
      if (['admin.html', 'admin.js'].includes(publicFile)) assertAdminRole(user.role);
      if (publicAssets.has(publicFile) || publicFile === 'admin.html') return await sendFile(req, res, path.join(config.root, 'public', publicFile));
      return json(res, 404, { error: 'Не найдено' });
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      if (temporaryConnectionFailure(error)) {
        console.error('Service connection unavailable:', error.code || 'CONNECTION_TIMEOUT');
        const requestPath = req.url?.split('?')[0] || '';
        if (req.method === 'GET' && (requestPath === '/' || requestPath === '/index.html' || requestPath === '/app' || requestPath === '/app/' || (requestPath.startsWith('/app/') && !path.extname(requestPath)))) {
          let html = await fs.readFile(path.join(vueRoot, 'index.html'), 'utf8');
          html = html.replace('<head>', '<head><meta name="account-id" content="pending"><meta name="account-role" content="pending">');
          res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          return res.end(html);
        }
        if (req.method === 'GET' && ['/legacy', '/legacy/', '/admin.html'].includes(req.url?.split('?')[0])) {
          res.writeHead(503, { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '5' });
          return res.end('<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Временная ошибка подключения</title><h1>Не удалось подключиться к сервису</h1><p>Связь с базой данных временно недоступна. Аккаунт и данные сохранены. Повторите через несколько секунд.</p><a href="/app">Повторить</a></html>');
        }
        return json(res, 503, { error: 'Связь с базой данных временно недоступна. Повторите через несколько секунд.', code: 'DATABASE_UNAVAILABLE', retryable: true });
      }
      const message = error.code?.startsWith('E') || error instanceof SyntaxError ? 'Не удалось обработать запрос' : error.message;
      const knownMessage = ['Некоррект', 'Недостаточно', 'Цена', 'Требуется', 'Для расчёта', 'Этот запрос', 'Укажите', 'Начисление', 'Проверьте', 'Генерация'].some(prefix => message.startsWith(prefix));
      const hiddenUnexpectedError = !error.status && !knownMessage;
      if (hiddenUnexpectedError) {
        const requestPath = req.url?.split('?')[0] || '';
        const rpc = /^\/api\/rpc\/([a-zA-Z]+)$/.exec(requestPath)?.[1];
        trace.write('service.request.error', { method: req.method, path: requestPath, rpc, error });
        console.error('Service request failed:', error.code || error.name || 'UNEXPECTED');
      }
      const status = error.status || (knownMessage ? 400 : 500);
      json(res, status, { error: hiddenUnexpectedError ? 'Не удалось выполнить запрос' : message,
        ...(error.status && /^[A-Z][A-Z0-9_]*$/.test(error.code || '') ? { code: error.code } : {}) });
    }
  });
  server.requestTimeout = 60000; server.headersTimeout = 15000;
  server.setAccountServices = async (nextAuth, nextAccounts, nextPayments = null, nextCommerce = null, nextGenerationServices = null) => {
    auth = nextAuth; accounts = nextAccounts; payments = nextPayments; commerce = nextCommerce;
    codex = nextGenerationServices?.codex || null;
    codexProvider = nextGenerationServices?.codexProvider || null;
    routerAi = nextGenerationServices?.routerAi || null;
    apimart = nextGenerationServices?.apimart || null;
    costRouter = nextGenerationServices?.costRouter || null;
    routerAiModels = nextGenerationServices?.routerAiModels || null;
    routerAiStatus = nextGenerationServices?.routerAiStatus || null;
  };
  server.closeEvents = () => { for (const connection of connections) connection.end(); };
  return server;
}
module.exports = { createHttpServer, readBody };
