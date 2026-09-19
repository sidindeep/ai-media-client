const http = require('node:http');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { validateCodexRequest } = require('../services/codex-request');
const { createCodexBilling } = require('../services/codex-billing');
const { buildInfo } = require('./build-info');
const { checkDatabase } = require('../database/database');
const sharedFiles = new Set(['renderer.js', 'provider-errors.js', 'styles.css', 'ru.js', 'templates-ui.js', 'source-preview.js', 'file-drop.js', 'choice-buttons.js', 'structured-fields.js', 'drafts.js', 'costs.js', 'tariff-snapshot.js', 'price-audit.js', 'duration.js', 'costs-ui.js']);
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' };
const publicAssets = new Set(['web.js', 'web.css', 'account-menu.js', 'native-costs.js', 'admin.js', 'codex-models.js']);
function temporaryConnectionFailure(error) {
  return ['EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', '57P01', '57P03', '53300'].includes(error.code)
    || /Connection terminated|connection timeout|timeout expired|timeout exceeded when trying to connect/i.test(error.message || '');
}
async function assetUser(auth, req, retry) {
  for (let attempt = 0; ; attempt++) {
    try { return await auth.user(req); }
    catch (error) {
      if (!retry || attempt >= 2 || !temporaryConnectionFailure(error)) throw error;
      await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
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
function createHttpServer({ config, service: legacyService, auth, accounts, telegramStatus = () => ({ enabled: false }) }) {
  const release = buildInfo(config.root);
  const codex = accounts && config.codex?.url ? createCodexBilling({ accounts, url: config.codex.url, dataDirectory: config.dataDirectory }) : null;
  const connections = new Set();
  let loginWindow = Date.now(), loginRequests = 0;
  const server = http.createServer(async (req, res) => {
    try {
      const localPort = server.address().port;
      const allowedHosts = new Set([`127.0.0.1:${localPort}`, `localhost:${localPort}`, `[::1]:${localPort}`]);
      if (config.publicOrigin) allowedHosts.add(new URL(config.publicOrigin).host);
      if (!allowedHosts.has(req.headers.host)) return json(res, 403, { error: 'Недопустимый адрес сервиса' });
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (auth && config.port !== 0 && req.method === 'GET' && (url.pathname === '/' || /^\/auth\/[a-z][a-z0-9_-]*\/start$/.test(url.pathname)) && req.headers.host !== new URL(config.auth.origin).host) {
        res.writeHead(302, { ...headers, Location: config.auth.origin + url.pathname + url.search, 'Cache-Control': 'no-store' }); res.end(); return;
      }
      const sameOrigin = !req.headers.origin || req.headers.origin === `http://${req.headers.host}` || (config.publicOrigin && req.headers.origin === config.publicOrigin);
      const callbackProvider = /^\/auth\/([a-z][a-z0-9_-]*)\/callback$/.exec(url.pathname)?.[1];
      const oauthCallback = req.method === 'GET' && auth?.providers().some(provider => provider.id === callbackProvider);
      const pageNavigation = ['GET', 'HEAD'].includes(req.method)
        && ['/', '/index.html', '/login'].includes(url.pathname)
        && req.headers['sec-fetch-mode'] === 'navigate'
        && req.headers['sec-fetch-dest'] === 'document';
      if (!pageNavigation && !oauthCallback && (!sameOrigin || req.headers['sec-fetch-site'] === 'cross-site')) return json(res, 403, { error: 'Запрос с другого сайта запрещён' });
      const redirect = (location, cookies) => { res.writeHead(302, { ...headers, Location: location, 'Cache-Control': 'no-store', ...(cookies ? { 'Set-Cookie': cookies } : {}) }); res.end(); };
      if (req.method === 'GET' && url.pathname === '/api/health') {
        const database = await checkDatabase(accounts?.pool);
        const status = database.state === 'unavailable' ? 503 : 200;
        return json(res, status, { ok: status === 200, version: release.version, build: release.build, database, generationConfigured: Boolean(legacyService.configured?.()), telegram: telegramStatus() });
      }
      if (req.method === 'GET' && url.pathname === '/api/version') return json(res, 200, release);
      if (auth && req.method === 'GET' && url.pathname === '/auth/providers') return json(res, 200, { result: auth.providers() });
      const authRoute = /^\/auth\/([a-z][a-z0-9_-]*)\/(start|callback)$/.exec(url.pathname);
      if (auth && req.method === 'GET' && authRoute) {
        if (Date.now() - loginWindow > 60000) { loginWindow = Date.now(); loginRequests = 0; }
        if (++loginRequests > 120) return json(res, 429, { error: 'Слишком много попыток входа. Повторите позже.' });
        if (authRoute[2] === 'start') { const result = await auth.begin(authRoute[1]); return redirect(result.location, result.cookie); }
        try { return redirect('/', await auth.finish(req, authRoute[1], url.searchParams)); }
        catch { return redirect('/login?error=oauth'); }
      }
      if (['GET', 'HEAD'].includes(req.method) && ['/login', '/login.js', '/web.css', '/version.js'].includes(url.pathname)) {
        return await sendFile(req, res, path.join(config.root, 'public', url.pathname === '/login' ? 'login.html' : url.pathname.slice(1)));
      }
      const shared = /^\/shared\/([^/]+)$/.exec(url.pathname);
      const isAsset = ['GET', 'HEAD'].includes(req.method)
        && (sharedFiles.has(shared?.[1]) || publicAssets.has(url.pathname.slice(1)) || url.pathname === '/codex-models.json');
      // Retry only the read-only session lookup for assets, never account/API writes.
      const user = auth ? await assetUser(auth, req, isAsset) : { id: 'local', role: 'admin', name: 'Владелец' };
      if (!user) {
        if (['/', '/index.html'].includes(url.pathname)) return redirect('/login');
        return json(res, 401, { error: 'Необходим вход в аккаунт' });
      }
      if (auth && req.method === 'POST' && req.headers['x-media-user'] !== user.id) return json(res, 409, { error: 'Аккаунт изменился. Перезагрузите страницу.' });
      if (url.pathname.startsWith('/api/codex/')) {
        if (req.method === 'GET' && url.pathname === '/api/codex/status') return json(res, 200, { enabled: Boolean(codex), allowed: Boolean(accounts) });
        if (!codex) return json(res, 503, { error: 'Codex требует подключённого сервиса и кредитного счёта.' });
        const imageRequest = /^\/api\/codex\/jobs\/([a-f0-9-]{36})\/image$/.exec(url.pathname);
        if (imageRequest && ['GET', 'HEAD'].includes(req.method)) {
          const selectedAccount = url.searchParams.get('account');
          if (selectedAccount) await accounts.scope(user, selectedAccount);
          return await sendFile(req, res, await codex.image(selectedAccount || user.id, imageRequest[1]), 'image/png', url.searchParams.get('download') === '1');
        }
        if (req.method === 'GET' && url.pathname === '/api/codex/quote') {
          try { return json(res, 200, { quote: codex.quote({ model: url.searchParams.get('model'), effort: url.searchParams.get('effort'), speed: url.searchParams.get('speed') }) }); }
          catch { return json(res, 200, { quote: null, error: 'Цена этого режима Codex ещё не опубликована.' }); }
        }
        const jobPath = /^\/api\/codex\/jobs(?:\/[a-f0-9-]{36})?$/.test(url.pathname);
        if (!jobPath || !['GET', 'POST'].includes(req.method) || (req.method === 'POST' && url.pathname !== '/api/codex/jobs')) return json(res, 404, { error: 'Не найдено' });
        if (req.method === 'POST') {
          if (req.headers['x-media-client'] !== 'web') return json(res, 403, { error: 'Недопустимый источник запроса' });
          const body = validateCodexRequest(JSON.parse((await readBody(req, 100000)).toString('utf8')));
          return json(res, 200, await codex.submit(user.id, body));
        }
        return json(res, 200, await codex.status(user.id, url.pathname.split('/').pop()));
      }
      if (req.method === 'POST' && url.pathname === '/auth/logout') {
        if (req.headers['x-media-client'] !== 'web') return json(res, 403, { error: 'Доступ запрещён' });
        res.setHeader('Set-Cookie', auth ? await auth.logout(req) : '');
        for (const connection of connections) if (connection.accountId === user.id) connection.end();
        return json(res, 200, { result: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/account') return json(res, 200, { result: { ...user, identities: auth ? await auth.identities(user.id) : [], wallet: accounts ? await accounts.wallet.get(user.id) : null } });
      if (accounts && req.method === 'POST' && url.pathname === '/api/account/profile' && req.headers['x-media-client'] === 'web') {
        const body = JSON.parse((await readBody(req, 4096)).toString('utf8'));
        if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 200) throw new Error('Укажите имя до 200 символов');
        await accounts.pool.query('UPDATE media_accounts SET display_name=$2 WHERE id=$1', [user.id, body.name.trim()]);
        return json(res, 200, { result: { name: body.name.trim() } });
      }
      if (url.pathname.startsWith('/api/admin/')) {
        if (!accounts || user.role !== 'admin') return json(res, 403, { error: 'Доступ запрещён' });
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
      const service = accounts && url.pathname.startsWith('/api/') ? await accounts.scope(user, selected) : legacyService;
      if (req.method === 'POST') {
        if (req.headers['x-media-client'] !== 'web') return json(res, 403, { error: 'Недопустимый источник запроса' });
        if (url.pathname === '/api/source') {
          const type = (req.headers['content-type'] || '').split(';')[0];
          if (!/^(image\/(png|jpeg|webp|gif)|video\/(mp4|webm|quicktime)|audio\/[a-z0-9.+-]+)$/.test(type)) throw new Error('Этот тип исходника не поддерживается');
          const bytes = await readBody(req, config.uploadLimit);
          const saved = await service.saveSource({ name: url.searchParams.get('name') || 'source', type, bytes });
          return json(res, 200, { result: saved });
        }
        const match = /^\/api\/rpc\/([a-zA-Z]+)$/.exec(url.pathname);
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
        service.events.on('changed', notify);
        const heartbeat = setInterval(async () => { try { if (auth && (await auth.user(req))?.id !== user.id) { res.end(); return; } if (!res.destroyed) res.write(': keepalive\n\n'); } catch { res.end(); } }, 15000);
        res.on('close', () => { clearInterval(heartbeat); connections.delete(res); service.events.off('changed', notify); });
        return;
      }
      const source = /^\/api\/sources\/([a-f0-9]{64})$/.exec(url.pathname);
      if (source) {
        const file = await service.sourceFile(source[1]);
        return await sendFile(req, res, file.path, file.type);
      }
      const result = /^\/api\/results\/([a-f0-9-]{36})\/(\d+)$/.exec(url.pathname);
      if (result) {
        const file = await service.resultFile(result[1], Number(result[2]));
        return await sendFile(req, res, file.path, null, url.searchParams.has('download'));
      }
      if (user.role !== 'admin' && shared && ['tariff-snapshot.js', 'costs.js', 'costs-ui.js', 'price-audit.js'].includes(shared[1])) return json(res, 403, { error: 'Доступ запрещён' });
      if (shared && sharedFiles.has(shared[1])) return await sendFile(req, res, path.join(config.root, 'src', shared[1]));
      const publicFile = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
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
        if (req.method === 'GET' && ['/', '/index.html', '/admin.html'].includes(req.url?.split('?')[0])) {
          res.writeHead(503, { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '5' });
          return res.end('<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Временная ошибка подключения</title><h1>Не удалось подключиться к сервису</h1><p>Связь с базой данных временно недоступна. Аккаунт и данные сохранены. Повторите через несколько секунд.</p><a href="/">Повторить</a></html>');
        }
        return json(res, 503, { error: 'Связь с базой данных временно недоступна. Повторите через несколько секунд.' });
      }
      const message = error.code?.startsWith('E') || error instanceof SyntaxError ? 'Не удалось обработать запрос' : error.message;
      json(res, error.status || 400, { error: accounts && !error.status && !['Некоррект', 'Недостаточно', 'Цена', 'Требуется', 'Для расчёта', 'Этот запрос', 'Укажите', 'Начисление', 'Проверьте', 'Генерация'].some(prefix => message.startsWith(prefix)) ? 'Не удалось выполнить запрос' : message });
    }
  });
  server.requestTimeout = 60000; server.headersTimeout = 15000;
  server.recoverCodex = () => codex?.recover();
  server.closeEvents = () => { codex?.close(); for (const connection of connections) connection.end(); };
  return server;
}
module.exports = { createHttpServer, readBody };
