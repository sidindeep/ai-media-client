const http = require('node:http');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const sharedFiles = new Set(['renderer.js', 'provider-errors.js', 'styles.css', 'ru.js', 'templates-ui.js', 'source-preview.js', 'file-drop.js', 'choice-buttons.js', 'structured-fields.js', 'drafts.js', 'costs.js', 'tariff-snapshot.js', 'price-audit.js', 'duration.js', 'costs-ui.js']);
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' };
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
function createHttpServer({ config, service, telegramStatus = () => ({ enabled: false }) }) {
  const connections = new Set();
  const server = http.createServer(async (req, res) => {
    try {
      const localPort = server.address().port;
      const allowedHosts = new Set([`127.0.0.1:${localPort}`, `localhost:${localPort}`, `[::1]:${localPort}`]);
      if (config.publicOrigin) allowedHosts.add(new URL(config.publicOrigin).host);
      if (!allowedHosts.has(req.headers.host)) return json(res, 403, { error: 'Недопустимый адрес сервиса' });
      const url = new URL(req.url, `http://${req.headers.host}`);
      const sameOrigin = !req.headers.origin || req.headers.origin === `http://${req.headers.host}` || (config.publicOrigin && req.headers.origin === config.publicOrigin);
      const pageNavigation = ['GET', 'HEAD'].includes(req.method)
        && ['/', '/index.html'].includes(url.pathname)
        && req.headers['sec-fetch-mode'] === 'navigate'
        && req.headers['sec-fetch-dest'] === 'document';
      if (!pageNavigation && (!sameOrigin || req.headers['sec-fetch-site'] === 'cross-site')) return json(res, 403, { error: 'Запрос с другого сайта запрещён' });
      if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, generationConfigured: service.configured(), telegram: telegramStatus() });
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
      if (url.pathname === '/api/events') {
        if (connections.size >= 20) return json(res, 429, { error: 'Слишком много открытых вкладок' });
        res.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write('data: ready\n\n'); connections.add(res);
        const notify = () => { if (!res.destroyed && res.writableLength < 65536) res.write('data: changed\n\n'); };
        service.events.on('changed', notify);
        const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': keepalive\n\n'); }, 15000);
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
      const shared = /^\/shared\/([^/]+)$/.exec(url.pathname);
      if (shared && sharedFiles.has(shared[1])) return await sendFile(req, res, path.join(config.root, 'src', shared[1]));
      const publicFile = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (['index.html', 'web.js', 'web.css'].includes(publicFile)) return await sendFile(req, res, path.join(config.root, 'public', publicFile));
      return json(res, 404, { error: 'Не найдено' });
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const message = error.code?.startsWith('E') || error instanceof SyntaxError ? 'Не удалось обработать запрос' : error.message;
      json(res, 400, { error: message });
    }
  });
  server.requestTimeout = 60000; server.headersTimeout = 15000;
  server.closeEvents = () => { for (const connection of connections) connection.end(); };
  return server;
}
module.exports = { createHttpServer, readBody };
