const http = require('node:http');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { validateCodexRequest } = require('../services/codex-request');
const { createCodexBilling } = require('../services/codex-billing');
const { createRouterAiBilling, validateRouterAiRequest } = require('../services/routerai-billing');
const { createRouterAiCatalog } = require('../providers/routerai/catalog');
const { createRouterAiClient } = require('../providers/routerai/client');
const { readProviderStatus } = require('../services/provider-status');
const { buildInfo } = require('./build-info');
const { checkDatabase, transientConnection } = require('../database/database');
const trace = require('../generation-log');
const sharedFiles = new Set(['renderer.js', 'provider-errors.js', 'styles.css', 'ru.js', 'templates-ui.js', 'source-preview.js', 'file-drop.js', 'choice-buttons.js', 'structured-fields.js', 'drafts.js', 'costs.js', 'tariff-snapshot.js', 'price-audit.js', 'duration.js', 'costs-ui.js']);
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' };
const publicAssets = new Set(['web.js', 'web.css', 'account-menu.js', 'native-costs.js', 'admin.js', 'codex-models.js']);
const publicPageAssets = new Set(['brand-logo.png', 'landing.css', 'landing.js', 'legal.css', 'login.js', 'web.css', 'version.js', 'theme.css', 'theme.js']);
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
function json(res, status, value) {
  res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function sendFile(req, res, filename, type, attachment = false) {
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
  res.writeHead(status, {
    ...headers, 'Content-Type': contentType, 'Content-Length': stat.size ? end - start + 1 : 0,
    'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
    ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${stat.size}` } : {}),
    ...(attachment ? { 'Content-Disposition': `attachment; filename="${path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_')}"` } : {})
  });
  if (req.method === 'HEAD' || !stat.size) { res.end(); return; }
  const stream = createReadStream(filename, { start, end });
  stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
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
function createHttpServer({ config, service: legacyService, auth, accounts, readiness, databaseAvailability, databaseWaitMs = 10000, telegramStatus = () => ({ enabled: false }), telegram = null, storage = null, payments = null, commerce = null }) {
  const release = buildInfo(config.root);
  let codex = accounts && config.codex?.url ? createCodexBilling({ accounts, url: config.codex.url, dataDirectory: config.dataDirectory, storage, content: accounts.content }) : null;
  const routerAiModels = createRouterAiCatalog();
  let routerAi = accounts && config.routerAi?.apiKey ? createRouterAiBilling({ accounts, apiKey: config.routerAi.apiKey,
    content: accounts.content, tariffFetcher: routerAiModels.tariff }) : null;
  const routerAiStatus = config.routerAi?.apiKey ? createRouterAiClient({ apiKey: config.routerAi.apiKey }) : null;
  const connections = new Set();
  let loginWindow = Date.now(), loginRequests = 0;
  const server = http.createServer(async (req, res) => {
    try {
      const localPort = server.address().port;
      const allowedHosts = new Set([`127.0.0.1:${localPort}`, `localhost:${localPort}`, `[::1]:${localPort}`]);
      if (config.publicOrigin) allowedHosts.add(new URL(config.publicOrigin).host);
      if (!allowedHosts.has(req.headers.host)) return json(res, 403, { error: 'Недопустимый адрес сервиса' });
      const url = new URL(req.url, `http://${req.headers.host}`);
      const normalizedPath = url.pathname.length > 1 ? url.pathname.replace(/\/$/, '') : url.pathname;
      if (req.method === 'POST' && url.pathname === `/api/payments/webhooks/yookassa/${config.payments?.environment || 'test'}`) {
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
      const oauthCallback = req.method === 'GET' && auth?.providers().some(provider => provider.id === callbackProvider);
      const oauthStartProvider = /^\/auth\/([a-z][a-z0-9_-]*)\/start$/.exec(url.pathname)?.[1];
      const oauthStart = req.method === 'GET' && auth?.providers().some(provider => provider.id === oauthStartProvider);
      const pageNavigation = ['GET', 'HEAD'].includes(req.method)
        && (['/', '/index.html', '/app', '/app/', '/legacy', '/legacy/', '/login'].includes(url.pathname) || Boolean(legalPage))
        && req.headers['sec-fetch-mode'] === 'navigate'
        && req.headers['sec-fetch-dest'] === 'document';
      const allowedTopLevelNavigation = pageNavigation || (oauthStart && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document');
      if (!allowedTopLevelNavigation && !oauthCallback && (!sameOrigin || req.headers['sec-fetch-site'] === 'cross-site')) return json(res, 403, { error: 'Запрос с другого сайта запрещён' });
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
        const root = path.join(config.root, 'public', 'vue');
        const relative = isLanding || url.pathname === vueAppPrefix || url.pathname === `${vueAppPrefix}/` ? 'index.html' : url.pathname.slice(`${vueAppPrefix}/`.length);
        if (!relative || relative.split('/').includes('..')) return json(res, 404, { error: 'Не найдено' });
        const sendVueIndex = async () => {
          let html = await fs.readFile(path.join(root, 'index.html'), 'utf8');
          const starterStatus = user && accounts?.starterPack ? await accounts.starterPack.status(user.id, user.role) : null;
          html = html.replace('<head>', `<head><meta name="account-id" content="${user?.id || 'pending'}"><meta name="account-role" content="${user?.role || 'pending'}"><meta name="account-model-access" content="${starterStatus?.modelAccess || 'pending'}">`);
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
        let startupUser = config.auth.enabled ? null : { id: 'local', role: 'admin', name: 'Владелец' };
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
        return json(res, status, { ok: status === 200, version: release.version, build: release.build, database, generationConfigured: Boolean(legacyService.configured?.()),
          payments: { enabled: Boolean(payments), salesEnabled: Boolean(commerce && config.commerce?.salesEnabled), environment: config.payments?.environment || 'test', provider: config.payments?.provider || null }, telegram: telegramStatus() });
      }
      if (req.method === 'GET' && url.pathname === '/api/version') return json(res, 200, release);
      if (auth && req.method === 'GET' && url.pathname === '/auth/providers') return json(res, 200, { result: auth.providers() });
      const authRoute = /^\/auth\/([a-z][a-z0-9_-]*)\/(start|callback)$/.exec(url.pathname);
      if (auth && req.method === 'GET' && authRoute) {
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
        return await sendFile(req, res, path.join(config.root, 'public', 'vue', 'model-icons', landingModelIcon));
      }
      if (['GET', 'HEAD'].includes(req.method) && isVuePublicAsset) return await sendVueApplication(null);
      if (config.auth.enabled && !auth && (isLanding || isVueApp) && ['GET', 'HEAD'].includes(req.method)) return await sendVueApplication(null);
      if (config.auth.enabled && !auth && retryReadOnlyRpc) await databaseAvailability?.waitUntilAvailable(databaseWaitMs);
      if (config.auth.enabled && !auth) return json(res, 503, { error: 'Подключаемся к базе данных. Повторите через несколько секунд.', code: 'DATABASE_UNAVAILABLE', retryable: true });
      // Retry only the read-only session lookup for assets, never account/API writes.
      const user = auth ? await assetUser(auth, req, isAsset || retryReadOnlyRpc) : { id: 'local', role: 'admin', name: 'Владелец' };
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
      if (url.pathname.startsWith('/api/codex/')) {
        await accounts?.starterPack?.assertProvider(user.id, user.role, 'codex');
        if (req.method === 'GET' && url.pathname === '/api/codex/status') return json(res, 200, { enabled: Boolean(codex), allowed: Boolean(accounts) });
        if (!codex) return json(res, 503, { error: 'Codex требует подключённого сервиса и кредитного счёта.' });
        const imageRequest = /^\/api\/codex\/jobs\/([a-f0-9-]{36})\/image$/.exec(url.pathname);
        if (imageRequest && ['GET', 'HEAD'].includes(req.method)) {
          const selectedAccount = url.searchParams.get('account');
          if (selectedAccount) await accounts.scope(user, selectedAccount);
          const file = await codex.image(selectedAccount || user.id, imageRequest[1]);
          return await sendMedia(req, res, () => file.storageKey
            ? sendStored(req, res, storage, file, url.searchParams.get('download') === '1')
            : sendFile(req, res, file, 'image/png', url.searchParams.get('download') === '1'));
        }
        if (req.method === 'GET' && url.pathname === '/api/codex/quote') {
          try { return json(res, 200, { quote: codex.quote({ model: url.searchParams.get('model'), effort: url.searchParams.get('effort'), speed: url.searchParams.get('speed') }) }); }
          catch { return json(res, 200, { quote: null, error: 'Цена этого режима Codex ещё не опубликована.' }); }
        }
        const jobPath = /^\/api\/codex\/jobs(?:\/[a-f0-9-]{36})?$/.test(url.pathname);
        if (!jobPath || !['GET', 'POST'].includes(req.method) || (req.method === 'POST' && url.pathname !== '/api/codex/jobs')) return json(res, 404, { error: 'Не найдено' });
        if (req.method === 'POST') {
          if (req.headers['x-media-client'] !== 'web') return json(res, 403, { error: 'Недопустимый источник запроса' });
          const raw = JSON.parse((await readBody(req, 100000)).toString('utf8'));
          const body = validateCodexRequest(raw);
          const binding = await accounts.workspaces.assertBinding(user.id, body.projectId, body.chatId);
          return json(res, 200, await codex.submit(user.id, { ...body, ...binding }));
        }
        return json(res, 200, await codex.status(user.id, url.pathname.split('/').pop()));
      }
      if (req.method === 'POST' && url.pathname === '/auth/logout') {
        if (req.headers['x-media-client'] !== 'web') return json(res, 403, { error: 'Доступ запрещён' });
        res.setHeader('Set-Cookie', auth ? await auth.logout(req) : '');
        for (const connection of connections) if (connection.accountId === user.id) connection.end();
        return json(res, 200, { result: true });
      }
      if (url.pathname.startsWith('/api/routerai/')) {
        await accounts?.starterPack?.assertProvider(user.id, user.role, 'media');
        if (!routerAi) return json(res, 503, { error: 'RouterAI не настроен.' });
        if (req.method === 'GET' && url.pathname === '/api/routerai/models') return json(res, 200, await routerAiModels.list(user.role));
        if (url.pathname.startsWith('/api/routerai/admin/')) {
          if (user.role !== 'admin') return json(res, 403, { error: 'Доступ запрещён' });
          if (req.method === 'GET' && url.pathname === '/api/routerai/admin/models') return json(res, 200, await routerAiModels.all(user.role));
          if (req.method === 'POST' && url.pathname === '/api/routerai/admin/jobs') {
            if (req.headers['x-media-client'] !== 'web') return json(res, 403, { error: 'Недопустимый источник запроса' });
            const raw = JSON.parse((await readBody(req, 300000)).toString('utf8'));
            const binding = await accounts.workspaces.assertBinding(user.id, raw.projectId, raw.chatId);
            return json(res, 200, await routerAi.submitAdmin(user.id, { ...raw, ...binding }, (await routerAiModels.all(user.role)).models));
          }
          const adminVideo = /^\/api\/routerai\/admin\/jobs\/([a-f0-9-]{36})\/video\/(status|content)$/.exec(url.pathname);
          if (req.method === 'GET' && adminVideo) {
            if (adminVideo[2] === 'status') return json(res, 200, await routerAi.adminVideo(user.id, adminVideo[1]));
            const bytes = await routerAi.adminVideo(user.id, adminVideo[1], true);
            res.writeHead(200, { ...headers, 'Content-Type': 'video/mp4', 'Content-Length': bytes.length,
              'Content-Disposition': `attachment; filename="routerai-${adminVideo[1]}.mp4"`, 'Cache-Control': 'no-store' });
            res.end(bytes); return;
          }
          return json(res, 404, { error: 'Не найдено' });
        }
        if (req.method === 'GET' && url.pathname === '/api/routerai/quote') {
          try {
            const allowed = (await routerAiModels.list(user.role)).models;
            const model = allowed.find(item => item.id === url.searchParams.get('model'));
            if (!model) return json(res, 403, { quote: null, error: 'Модель RouterAI недоступна.' });
            const rawPayload = url.searchParams.get('payload') || '{}';
            if (rawPayload.length > 4096) return json(res, 400, { quote: null, error: 'Параметры слишком длинные.' });
            const payload = JSON.parse(rawPayload);
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return json(res, 400, { quote: null, error: 'Некорректные параметры.' });
            return json(res, 200, { quote: await routerAi.quote({ model: model.id, endpoint: model.endpoint ||
              (model.kind === 'image' ? 'images' : 'chat/completions'), payload }, user.role) });
          }
          catch (error) { return json(res, 200, { quote: null, error: error.message || 'Цена модели RouterAI не опубликована.' }); }
        }
        const imageRequest = /^\/api\/routerai\/jobs\/([a-f0-9-]{36})\/image$/.exec(url.pathname);
        if (imageRequest && ['GET', 'HEAD'].includes(req.method)) {
          const file = await routerAi.image(user.id, imageRequest[1]);
          return sendMedia(req, res, () => file.storageKey
            ? sendStored(req, res, storage, file, url.searchParams.get('download') === '1' || file.type === 'image/svg+xml')
            : sendFile(req, res, file.path, file.type, url.searchParams.get('download') === '1' || file.type === 'image/svg+xml'));
        }
        if (req.method === 'POST' && url.pathname === '/api/routerai/jobs') {
          if (req.headers['x-media-client'] !== 'web') return json(res, 403, { error: 'Недопустимый источник запроса' });
          const allowed = (await routerAiModels.list(user.role)).models;
          const raw = JSON.parse((await readBody(req, 100000)).toString('utf8'));
          const body = validateRouterAiRequest(raw, allowed);
          const binding = await accounts.workspaces.assertBinding(user.id, body.projectId, body.chatId);
          const job = await routerAi.submit(user.id, { ...raw, ...binding }, user.role, allowed);
          if (user.role !== 'admin') delete job.providerCostRub;
          return json(res, 200, job);
        }
        const jobRequest = /^\/api\/routerai\/jobs\/([a-f0-9-]{36})$/.exec(url.pathname);
        if (req.method === 'GET' && jobRequest) {
          const job = await routerAi.get(user.id, jobRequest[1]);
          if (job && user.role !== 'admin') delete job.providerCostRub;
          return job ? json(res, 200, job) : json(res, 404, { error: 'Запрос не найден' });
        }
        return json(res, 404, { error: 'Не найдено' });
      }
      if ((isLanding || isVueApp) && ['GET', 'HEAD'].includes(req.method)) {
        return await sendVueApplication(user);
      }
      if (req.method === 'GET' && url.pathname === '/api/account') return json(res, 200, { result: { ...user, identities: auth ? await auth.identities(user.id) : [], wallet: accounts ? await accounts.wallet.get(user.id) : null,
        starterPack: accounts?.starterPack ? await accounts.starterPack.status(user.id, user.role) : null } });
      if (accounts && url.pathname.startsWith('/api/commerce/')) {
        if (!commerce) return json(res, 503, { error: 'Платёжный модуль пока недоступен', code: 'PAYMENTS_DISABLED' });
        const checkoutMode = config.payments?.provider === 'yookassa-stub' ? 'stub' : 'redirect';
        if (req.method === 'GET' && url.pathname === '/api/commerce/offers') return json(res, 200, { result: config.commerce?.salesEnabled ? commerce.offers().map(offer => ({ ...offer, checkoutMode })) : [] });
        if (req.method === 'GET' && url.pathname === '/api/commerce/orders') return json(res, 200, { result: (await commerce.listOrders(user.id)).map(order => ({ ...order, checkoutMode })) });
        const orderMatch = /^\/api\/commerce\/orders\/([a-f0-9-]{36})(?:\/(checkout))?$/.exec(url.pathname);
        if (req.method === 'GET' && orderMatch && !orderMatch[2]) return json(res, 200, { result: { ...await commerce.getOrder(user.id, orderMatch[1]), checkoutMode } });
        if (req.method === 'POST' && url.pathname === '/api/commerce/orders' && req.headers['x-media-client'] === 'web') {
          if (!config.commerce?.salesEnabled) return json(res, 503, { error: 'Продажа кредитов пока недоступна', code: 'SALES_DISABLED' });
          const body = JSON.parse((await readBody(req, 8192)).toString('utf8'));
          return json(res, 200, { result: await commerce.createOrder(user.id, body) });
        }
        if (req.method === 'POST' && orderMatch?.[2] === 'checkout' && req.headers['x-media-client'] === 'web') {
          if (!config.commerce?.salesEnabled) return json(res, 503, { error: 'Продажа кредитов пока недоступна', code: 'SALES_DISABLED' });
          const returnUrl = `${config.auth.origin}/app?order=${encodeURIComponent(orderMatch[1])}`;
          return json(res, 200, { result: { ...await commerce.checkout(user.id, orderMatch[1], returnUrl), checkoutMode } });
        }
        return json(res, 404, { error: 'Метод не найден' });
      }
      if (accounts && req.method === 'POST' && url.pathname === '/api/account/profile' && req.headers['x-media-client'] === 'web') {
        const body = JSON.parse((await readBody(req, 4096)).toString('utf8'));
        if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 200) throw new Error('Укажите имя до 200 символов');
        await accounts.pool.query('UPDATE media_accounts SET display_name=$2 WHERE id=$1', [user.id, body.name.trim()]);
        return json(res, 200, { result: { name: body.name.trim() } });
      }
      if (accounts && req.method === 'GET' && url.pathname === '/api/workspace/sync') {
        const selectedWorkspaceAccount = req.headers['x-media-account'] || url.searchParams.get('account') || undefined;
        const workspaceAccount = selectedWorkspaceAccount || user.id;
        const scopedService = await accounts.scope(user, selectedWorkspaceAccount);
        const rawSince = url.searchParams.get('since');
        const since = rawSince ? new Date(rawSince) : null;
        if (since && Number.isNaN(since.getTime())) return json(res, 400, { error: 'Некорректный курсор синхронизации' });
        if (!since) await accounts.workspaces.ensureDefaultChat(workspaceAccount);
        const activeIds = url.searchParams.getAll('active');
        if (activeIds.length > 20 || activeIds.some(id => !/^[a-f0-9-]{36}$/.test(id))) return json(res, 400, { error: 'Некорректный список активных задач' });
        const cursorValue = (await accounts.pool.query('SELECT clock_timestamp() AS cursor')).rows[0]?.cursor;
        const cursor = cursorValue instanceof Date ? cursorValue.toISOString() : new Date(cursorValue).toISOString();
        const [records, projects, chats, queue] = await Promise.all([
          scopedService.dispatch(since ? 'getHistoryDelta' : 'getHistory', since ? [{ since: since.toISOString(), before: cursor, activeIds }] : []),
          since ? accounts.workspaces.listProjectChanges(workspaceAccount, since.toISOString(), cursor) : accounts.workspaces.listProjects(workspaceAccount),
          since ? accounts.workspaces.listChatChanges(workspaceAccount, since.toISOString(), cursor) : accounts.workspaces.listChats(workspaceAccount),
          scopedService.dispatch('queueStatus'),
        ]);
        return json(res, 200, { result: { cursor, full: !since, records, projects, chats, queue } });
      }
      if (accounts && /^\/api\/(projects|chats)(?:\/[^/]+(?:\/(archive|move))?)?$/.test(url.pathname)) {
        const selectedWorkspaceAccount = req.headers['x-media-account'] || url.searchParams.get('account') || undefined;
        const workspaceAccount = selectedWorkspaceAccount || user.id;
        const workspaceService = await accounts.scope(user, selectedWorkspaceAccount);
        const workspacePath = url.pathname.split('/').filter(Boolean);
        const resource = workspacePath[1], resourceId = workspacePath[2], action = workspacePath[3];
        const workspaceBody = async limit => JSON.parse((await readBody(req, limit)).toString('utf8'));
        const workspaceChanged = result => { workspaceService.events?.emit('changed'); return json(res, 200, { result }); };
        if (resource === 'projects') {
          if (req.method === 'GET' && !resourceId) return json(res, 200, { result: await accounts.workspaces.listProjects(workspaceAccount, url.searchParams.get('includeArchived') === 'true') });
          if (req.method === 'POST' && !resourceId && req.headers['x-media-client'] === 'web') return workspaceChanged(await accounts.workspaces.createProject(workspaceAccount, (await workspaceBody(4096)).name));
          if (req.method === 'PATCH' && resourceId && !action && req.headers['x-media-client'] === 'web') return workspaceChanged(await accounts.workspaces.renameProject(workspaceAccount, resourceId, (await workspaceBody(4096)).name));
          if (req.method === 'POST' && resourceId && action === 'archive' && req.headers['x-media-client'] === 'web') return workspaceChanged(await accounts.workspaces.archiveProject(workspaceAccount, resourceId));
        }
        if (resource === 'chats') {
          if (req.method === 'GET' && !resourceId) {
            const projectFilter = url.searchParams.has('projectId') ? (url.searchParams.get('projectId') || null) : undefined;
            return json(res, 200, { result: await accounts.workspaces.listChats(workspaceAccount, { projectId: projectFilter, includeArchived: url.searchParams.get('includeArchived') === 'true' }) });
          }
          if (req.method === 'GET' && resourceId && !action) return json(res, 200, { result: await accounts.workspaces.getChat(workspaceAccount, resourceId) });
          if (req.method === 'POST' && !resourceId && req.headers['x-media-client'] === 'web') return workspaceChanged(await accounts.workspaces.createChat(workspaceAccount, await workspaceBody(8192)));
          if (req.method === 'PATCH' && resourceId && !action && req.headers['x-media-client'] === 'web') return workspaceChanged(await accounts.workspaces.renameChat(workspaceAccount, resourceId, (await workspaceBody(4096)).name));
          if (req.method === 'POST' && resourceId && action === 'archive' && req.headers['x-media-client'] === 'web') return workspaceChanged(await accounts.workspaces.archiveChat(workspaceAccount, resourceId));
          if (req.method === 'POST' && resourceId && action === 'move' && req.headers['x-media-client'] === 'web') return workspaceChanged(await accounts.workspaces.moveChat(workspaceAccount, resourceId, (await workspaceBody(4096)).projectId ?? null));
        }
        return json(res, 404, { error: 'Метод не найден' });
      }
      if (url.pathname.startsWith('/api/admin/')) {
        if (!accounts || user.role !== 'admin') return json(res, 403, { error: 'Доступ запрещён' });
        if (url.pathname === '/api/admin/credit-conversion' && req.method === 'GET') {
          return json(res, 200, { result: accounts.conversion.snapshot() });
        }
        if (url.pathname === '/api/admin/provider-status' && req.method === 'GET') {
          const provider = url.searchParams.get('provider');
          const kieAccountId = url.searchParams.get('kieAccountId') || 'primary';
          const codexLimits = config.codex?.url ? async () => {
            const response = await fetch(`${config.codex.url.replace(/\/$/, '')}/auth/limits`, {
              headers: { 'x-account-id': user.id }, signal: AbortSignal.timeout(15000),
            });
            if (!response.ok) throw new Error('Не удалось прочитать лимиты Codex');
            return response.json();
          } : null;
          try { return json(res, 200, await readProviderStatus({ provider, kieAccountId, kie: accounts.provider, routerAi: routerAiStatus, codex: codexLimits })); }
          catch (error) { return json(res, error.status === 400 ? 400 : 502, { error: error.message || 'Не удалось проверить поставщика' }); }
        }
        if (url.pathname === '/api/admin/kie-submissions' && req.method === 'GET') {
          const { kieSubmissionStatistics } = require('../services/kie-submission-statistics');
          return json(res, 200, { result: await kieSubmissionStatistics(accounts.pool, url.searchParams.get('days') || 30) });
        }
        if (url.pathname.startsWith('/api/admin/codex/')) {
          const action = url.pathname.slice('/api/admin/codex/'.length);
          if (!((action === 'status' && req.method === 'GET') || (['start', 'cancel'].includes(action) && req.method === 'POST' && req.headers['x-media-client'] === 'web'))) return json(res, 404, { error: 'Не найдено' });
          if (!config.codex?.url) return json(res, 503, { error: 'Сервис Codex не подключён на сервере.' });
          try {
            const response = await fetch(`${config.codex.url.replace(/\/$/, '')}/auth/${action}`, { method: req.method, headers: { 'x-account-id': user.id }, signal: AbortSignal.timeout(15000) });
            if (!response.ok) return json(res, 502, { error: 'Обновите и проверьте сервис Codex на сервере.' });
            return json(res, 200, { result: await response.json() });
          } catch { return json(res, 502, { error: 'Сервис Codex не отвечает. Проверьте его запуск.' }); }
        }
        if (url.pathname === '/api/admin/accounts' && req.method === 'GET') return json(res, 200, { result: await accounts.list() });
        if (url.pathname === '/api/admin/starter-pack' && req.method === 'GET') return json(res, 200, { result: await accounts.starterOverview() });
        if (url.pathname === '/api/admin/roles' && req.method === 'POST' && req.headers['x-media-client'] === 'web') {
          const body = JSON.parse((await readBody(req, 4096)).toString('utf8'));
          await accounts.setRole(user.id, body.accountId, body.role, body.reason);
          return json(res, 200, { result: true });
        }
        if (url.pathname === '/api/admin/roles' && req.method === 'GET') return json(res, 200, { result: await accounts.audit() });
        if (url.pathname === '/api/admin/ledger' && req.method === 'GET') return json(res, 200, { result: await accounts.ledger(url.searchParams.get('account')) });
        if (url.pathname === '/api/admin/reconcile' && req.method === 'POST' && req.headers['x-media-client'] === 'web') {
          const body = JSON.parse((await readBody(req, 8192)).toString('utf8'));
          const result = await accounts.reconcile(user.id, body.accountId, body.jobId, body.outcome, body.evidence);
          return json(res, 200, { result });
        }
        if (url.pathname === '/api/admin/grant' && req.method === 'POST' && req.headers['x-media-client'] === 'web') {
          const body = JSON.parse((await readBody(req, 4096)).toString('utf8'));
          await accounts.wallet.grant(user.id, body.accountId, body.amountUnits, body.reference, body.note);
          return json(res, 200, { result: await accounts.wallet.get(body.accountId) });
        }
        return json(res, 404, { error: 'Метод не найден' });
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
          const type = (req.headers['content-type'] || '').split(';')[0];
          if (!/^(image\/(png|jpeg|webp|gif)|video\/(mp4|webm|quicktime)|audio\/[a-z0-9.+-]+)$/.test(type)) throw new Error('Этот тип исходника не поддерживается');
          const bytes = await readBody(req, config.uploadLimit);
          const binding = accounts ? await accounts.workspaces.assertBinding(selected || user.id, url.searchParams.get('projectId') || undefined, url.searchParams.get('chatId') || undefined) : {};
          const saved = await service.saveSource({ name: url.searchParams.get('name') || 'source', type, bytes, ...binding });
          return json(res, 200, { result: saved });
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
        if (connections.size >= 20) return json(res, 429, { error: 'Слишком много открытых вкладок' });
        res.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write('data: ready\n\n'); res.accountId = user.id; connections.add(res);
        const notify = () => { if (!res.destroyed && res.writableLength < 65536) res.write('data: changed\n\n'); };
        const reset = () => { if (!res.destroyed && res.writableLength < 65536) res.write('data: reset\n\n'); };
        service.events.on('changed', notify);
        service.events.on('reset', reset);
        const heartbeat = setInterval(async () => { try { if (auth && (await auth.user(req))?.id !== user.id) { res.end(); return; } if (!res.destroyed) res.write(': keepalive\n\n'); } catch { res.end(); } }, 15000);
        res.on('close', () => { clearInterval(heartbeat); connections.delete(res); service.events.off('changed', notify); service.events.off('reset', reset); });
        return;
      }
      const source = /^\/api\/sources\/([a-f0-9]{64})$/.exec(url.pathname);
      if (source) {
        const file = await service.sourceFile(source[1]);
        return await sendMedia(req, res, () => file.storageKey ? sendStored(req, res, storage, file) : sendFile(req, res, file.path, file.type));
      }
      const result = /^\/api\/results\/([a-f0-9-]{36})\/(\d+)$/.exec(url.pathname);
      if (result) {
        const file = await service.resultFile(result[1], Number(result[2]));
        return await sendMedia(req, res, () => file.storageKey
          ? sendStored(req, res, storage, file, url.searchParams.has('download'))
          : sendFile(req, res, file.path, null, url.searchParams.has('download')));
      }
      const contentRequest = /^\/api\/content\/([a-f0-9-]{36})$/.exec(url.pathname);
      if (contentRequest) {
        if (!accounts?.content) throw Object.assign(new Error('Хранилище контента не подключено'), { status: 503 });
        const accountId = selected || user.id;
        const file = await accounts.content.file(accountId, contentRequest[1]);
        const attachment = url.searchParams.has('download') || file.type === 'image/svg+xml';
        return file.storageKey ? sendStored(req, res, storage, file, attachment) : sendFile(req, res, file.path, file.type, attachment);
      }
      if (user.role !== 'admin' && shared && ['tariff-snapshot.js', 'costs.js', 'costs-ui.js', 'price-audit.js'].includes(shared[1])) return json(res, 403, { error: 'Доступ запрещён' });
      if (shared && sharedFiles.has(shared[1])) return await sendFile(req, res, path.join(config.root, 'src', shared[1]));
      const publicFile = isLegacyApp ? 'index.html' : url.pathname.slice(1);
      if (publicFile === 'index.html') {
        let html = await fs.readFile(path.join(config.root, 'public/index.html'), 'utf8');
        html = html.replace('<head>', `<head><meta name="account-id" content="${user.id}"><meta name="account-role" content="${user.role}">`);
        if (user.role !== 'admin') {
          html = html.replace(/<!-- provider-settings:start -->[\s\S]*?<!-- provider-settings:end -->/, '');
          html = html.replace(/<details id="officialTariff">[\s\S]*?<\/details>/, '');
          html = html.replace(/<script src="\/shared\/(tariff-snapshot|costs|price-audit|costs-ui)\.js"><\/script>/g, '');
          html = html.replace('<script src="/shared/renderer.js">', '<script src="/native-costs.js"></script><script src="/shared/renderer.js">');
          html = html.replace('<body>', '<body class="native-account">');
        }
        res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(req.method === 'HEAD' ? '' : html);
      }
      if (['admin.html', 'admin.js'].includes(publicFile) && user.role !== 'admin') return json(res, 403, { error: 'Доступ запрещён' });
      if (publicAssets.has(publicFile) || publicFile === 'admin.html') return await sendFile(req, res, path.join(config.root, 'public', publicFile));
      return json(res, 404, { error: 'Не найдено' });
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      if (temporaryConnectionFailure(error)) {
        console.error('Service connection unavailable:', error.code || 'CONNECTION_TIMEOUT');
        const requestPath = req.url?.split('?')[0] || '';
        if (req.method === 'GET' && (requestPath === '/' || requestPath === '/index.html' || requestPath === '/app' || requestPath === '/app/' || (requestPath.startsWith('/app/') && !path.extname(requestPath)))) {
          let html = await fs.readFile(path.join(config.root, 'public', 'vue', 'index.html'), 'utf8');
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
      const hiddenUnexpectedError = accounts && !error.status && !knownMessage;
      if (hiddenUnexpectedError) {
        const requestPath = req.url?.split('?')[0] || '';
        const rpc = /^\/api\/rpc\/([a-zA-Z]+)$/.exec(requestPath)?.[1];
        trace.write('service.request.error', { method: req.method, path: requestPath, rpc, error });
        console.error('Service request failed:', error.code || error.name || 'UNEXPECTED');
      }
      json(res, error.status || 400, { error: hiddenUnexpectedError ? 'Не удалось выполнить запрос' : message });
    }
  });
  server.requestTimeout = 60000; server.headersTimeout = 15000;
  server.recoverCodex = () => codex?.recover();
  server.recoverRouterAi = () => routerAi?.recover();
  server.setAccountServices = async (nextAuth, nextAccounts, nextPayments = null, nextCommerce = null) => {
    codex?.close();
    auth = nextAuth;
    accounts = nextAccounts;
    payments = nextPayments;
    commerce = nextCommerce;
    codex = accounts && config.codex?.url ? createCodexBilling({ accounts, url: config.codex.url, dataDirectory: config.dataDirectory, storage, content: accounts.content }) : null;
    routerAi = accounts && config.routerAi?.apiKey ? createRouterAiBilling({ accounts, apiKey: config.routerAi.apiKey,
      content: accounts.content, tariffFetcher: routerAiModels.tariff }) : null;
    await codex?.recover();
    await routerAi?.recover();
  };
  server.closeEvents = () => { codex?.close(); for (const connection of connections) connection.end(); };
  return server;
}
module.exports = { createHttpServer, readBody };
