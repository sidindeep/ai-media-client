const { SourceError } = require('../../services/movie-sources');

async function handleMovieSources({ req, res, url, user, sameOrigin, sources, readJson, send, headers, recordSystemEvent }) {
  if (req.method !== 'POST') return send(405, { error: 'Используйте POST.' });
  if (!sameOrigin || req.headers['x-media-client'] !== 'web' || !String(req.headers['content-type'] || '').startsWith('application/json'))
    return send(403, { error: 'Доступ запрещён.' });
  const controller = new AbortController();
  const abort = () => { if (!res.writableEnded) controller.abort(); };
  res.once('close', abort);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(url.pathname.endsWith('/file') ? 180000 : 60000)]);
  try {
    const body = await readJson(4096);
    return await sources.run(user.id, async () => {
      if (url.pathname === '/api/movie/sources/list') return send(200, { result: await sources.list(user.id, body.url, body.limit, signal) });
      const file = await sources.download(user.id, body.id, signal);
      if (signal.aborted || res.destroyed) return;
      res.writeHead(200, { ...headers, 'Content-Type': file.type, 'Content-Length': file.bytes.length, 'Cache-Control': 'no-store' });
      res.end(file.bytes);
    });
  } catch (error) {
    if (res.destroyed) return;
    if (error instanceof SourceError) return send(error.status, { error: error.message, code: error.code });
    if (error instanceof SyntaxError) return send(400, { error: 'Некорректный запрос.' });
    recordSystemEvent('remotion', 'movie.source.error', Object.assign(new Error('Remote movie source request failed'), { code: 'MOVIE_SOURCE_FETCH' }), {
      diagnostic: { file: 'src/services/movie-sources.js', entity: 'movie', description: 'Remote source request failed; no URLs or filenames included' },
    });
    return send(422, { error: signal.aborted ? 'Время загрузки истекло. Повторите импорт.' : 'Не удалось загрузить источник. Проверьте публичную HTTPS-ссылку.', code: 'MOVIE_SOURCE_FETCH' });
  } finally { res.off('close', abort); }
}
module.exports = { handleMovieSources };
