const { randomUUID } = require('node:crypto');
const { fetchPublicResult, publicResultUrl } = require('./content-service');

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_ITEMS = 20;
const TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm']);
const EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm' };
class SourceError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
function sourceUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new SourceError('MOVIE_SOURCE_URL', 'Укажите полную HTTPS-ссылку на папку или файл.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || String(value).length > 2048)
    throw new SourceError('MOVIE_SOURCE_URL', 'Допустимы только публичные HTTPS-ссылки без логина и пароля.');
  url.hash = '';
  try { publicResultUrl(url.href); } catch { throw new SourceError('MOVIE_SOURCE_URL', 'Недопустимый адрес: требуется публичный HTTPS-источник.'); }
  return url;
}
function mediaType(name, type) {
  const mime = String(type || '').split(';')[0].toLowerCase();
  // Disk sometimes labels an MP4 container as QuickTime.
  if (TYPES.has(mime)) return mime;
  if (!mime || ['application/octet-stream', 'video/quicktime'].includes(mime)) return EXT[String(name).split('.').pop().toLowerCase()];
}
async function readLimited(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new SourceError('MOVIE_SOURCE_SIZE', 'Файл превышает допустимый размер.');
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new SourceError('MOVIE_SOURCE_SIZE', 'Файл превышает допустимый размер.');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally { await reader.cancel().catch(() => {}); }
}

function createMovieSources({ fetchImpl = (url, signal, headers) => fetchPublicResult(url, signal, undefined, undefined, headers), googleApiKey = process.env.MEDIA_GOOGLE_DRIVE_API_KEY || '' } = {}) {
  const tickets = new Map();
  const active = new Set();
  function prune() { for (const [id, ticket] of tickets) if (ticket.expires < Date.now()) tickets.delete(id); }
  async function request(value, signal, headers = {}) {
    let target = sourceUrl(value).href;
    for (let redirect = 0; redirect < 6; redirect++) {
      const response = await fetchImpl(target, signal, headers);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location'); await response.body?.cancel();
        if (!location) break;
        target = sourceUrl(new URL(location, target).href).href;
        headers = {};
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new SourceError('MOVIE_SOURCE_ACCESS', 'Не удалось получить файлы. Проверьте публичный доступ и разрешение на скачивание.', 422);
      }
      return { response, target };
    }
    throw new SourceError('MOVIE_SOURCE_REDIRECT', 'Слишком много перенаправлений ссылки.', 422);
  }
  async function json(value, signal, headers) {
    const { response } = await request(value, signal, headers);
    try { return JSON.parse((await readLimited(response, 2 * 1024 * 1024)).toString('utf8')); }
    catch (error) { if (error instanceof SourceError) throw error; throw new SourceError('MOVIE_SOURCE_LIST', 'Сервис не вернул список файлов.', 422); }
  }
  function yandexUrl(publicKey, pathname = '', offset = 0, download = false) {
    return 'https://cloud-api.yandex.net/v1/disk/public/resources' + (download ? '/download' : '') + '?' + new URLSearchParams({
      public_key: publicKey, ...(pathname ? { path: pathname } : {}), ...(!download ? { limit: '100', offset: String(offset), sort: 'name' } : {}),
    });
  }
  async function list(owner, value, limit, signal) {
    prune();
    for (const [id, ticket] of tickets) if (ticket.owner === owner) tickets.delete(id);
    const url = sourceUrl(value);
    const files = []; let skipped = 0; let truncated = false; let requests = 0;
    const max = Math.min(MAX_ITEMS, Math.max(1, Number.isInteger(limit) ? limit : MAX_ITEMS));
    const seen = new Set();
    function add(name, type, size, source) {
      const mime = mediaType(name, type);
      if (!mime || Number(size) > MAX_FILE_BYTES) { skipped++; return; }
      const key = JSON.stringify(source);
      if (seen.has(key)) return;
      seen.add(key);
      if (files.length >= max) { truncated = true; return; }
      files.push({ name: String(name || 'media').replace(/[\u0000-\u001f]/g, '').slice(0, 255), type: mime, size: Number(size) || null, source });
    }
    if (['disk.yandex.ru', 'disk.yandex.com', 'yadi.sk'].includes(url.hostname)) {
      const queue = [{ path: '', offset: 0, depth: 0 }];
      while (queue.length && !truncated && requests++ < 50) {
        const folder = queue.shift();
        const data = await json(yandexUrl(url.href, folder.path, folder.offset), signal);
        if (data.type === 'file') { add(data.name, data.mime_type, data.size, { provider: 'yandex', key: url.href, path: data.path || folder.path }); continue; }
        for (const item of data._embedded?.items || []) {
          if (item.type === 'dir') {
            if (folder.depth < 5 && queue.length < 100) queue.push({ path: item.path, offset: 0, depth: folder.depth + 1 }); else truncated = true;
          } else add(item.name, item.mime_type, item.size, { provider: 'yandex', key: url.href, path: item.path });
        }
        if ((data._embedded?.total || 0) > folder.offset + 100) queue.push({ ...folder, offset: folder.offset + 100 });
      }
      if (queue.length) truncated = true;
    } else if (url.hostname === 'drive.google.com') {
      if (!googleApiKey) throw new SourceError('MOVIE_GOOGLE_CONFIG', 'Импорт Google Drive ещё не настроен администратором. Нужен ключ Google Drive API для публичных папок.', 422);
      const folderId = /\/folders\/([\w-]+)/.exec(url.pathname)?.[1];
      const fileId = /\/file\/d\/([\w-]+)/.exec(url.pathname)?.[1] || url.searchParams.get('id');
      if (!folderId && !/^[\w-]+$/.test(fileId || '')) throw new SourceError('MOVIE_SOURCE_URL', 'Укажите ссылку Google Drive на папку или файл.');
      const queue = [{ id: folderId || fileId, depth: 0, page: '', resourceKey: url.searchParams.get('resourcekey') }];
      while (queue.length && !truncated && requests++ < 50) {
        const folder = queue.shift();
        const query = new URLSearchParams({ key: googleApiKey, fields: folderId ? 'nextPageToken,files(id,name,mimeType,size,resourceKey)' : 'id,name,mimeType,size,resourceKey',
          ...(folderId ? { q: `'${folder.id}' in parents and trashed = false`, pageSize: '100', orderBy: 'name', ...(folder.page ? { pageToken: folder.page } : {}) } : {}) });
        const data = await json(`https://www.googleapis.com/drive/v3/files${folderId ? '' : '/' + folder.id}?${query}`, signal,
          folder.resourceKey ? { 'X-Goog-Drive-Resource-Keys': `${folder.id}/${folder.resourceKey}` } : {});
        for (const item of folderId ? data.files || [] : [data]) {
          if (item.mimeType === 'application/vnd.google-apps.folder') {
            if (folder.depth < 5 && queue.length < 100) queue.push({ id: item.id, depth: folder.depth + 1, page: '', resourceKey: item.resourceKey }); else truncated = true;
          } else add(item.name, item.mimeType, item.size, { provider: 'google', id: item.id, resourceKey: item.resourceKey });
        }
        if (data.nextPageToken) queue.push({ ...folder, page: data.nextPageToken });
      }
      if (queue.length) truncated = true;
    } else {
      const name = decodeURIComponent(url.pathname.split('/').pop() || 'media');
      if (mediaType(name)) add(name, '', null, { provider: 'direct', url: url.href });
      else {
        const { response, target } = await request(url.href, signal);
        const type = response.headers.get('content-type') || '';
        if (mediaType(name, type)) { await response.body?.cancel(); add(name, type, response.headers.get('content-length'), { provider: 'direct', url: target }); }
        else {
          const text = (await readLimited(response, 2 * 1024 * 1024)).toString('utf8');
          let entries;
          if (/json/i.test(type)) {
            let data; try { data = JSON.parse(text); } catch { throw new SourceError('MOVIE_SOURCE_LIST', 'Некорректный JSON-список файлов.', 422); }
            entries = Array.isArray(data) ? data : data.files;
            if (!Array.isArray(entries)) throw new SourceError('MOVIE_SOURCE_LIST', 'Ожидается JSON-массив files с URL файлов.', 422);
          } else if (/html/i.test(type)) entries = [...text.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)].map(match => match[1].replace(/&amp;/g, '&'));
          else entries = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
          for (const item of entries.slice(0, 1000)) {
            try {
              const file = sourceUrl(new URL(typeof item === 'string' ? item : item.url, target).href);
              const filename = (typeof item === 'object' && item.name) || decodeURIComponent(file.pathname.split('/').pop());
              add(filename, typeof item === 'object' ? item.type : '', typeof item === 'object' ? item.size : null, { provider: 'direct', url: file.href });
            } catch { skipped++; }
          }
          if (entries.length > 1000) truncated = true;
        }
      }
    }
    if (!files.length) throw new SourceError('MOVIE_SOURCE_EMPTY', 'Нет доступных фото PNG/JPEG/WebP или видео MP4/WebM до 100 МБ. Для другого сервиса нужна прямая ссылка или открытый список файлов.', 422);
    if (tickets.size + files.length > 2000) throw new SourceError('MOVIE_SOURCE_BUSY', 'Слишком много импортов. Попробуйте позже.', 429);
    return { files: files.map(({ source, ...file }) => {
      const id = randomUUID(); tickets.set(id, { owner, source, ...file, expires: Date.now() + 30 * 60 * 1000 }); return { id, ...file };
    }), skipped, truncated };
  }
  async function download(owner, id, signal) {
    prune(); const ticket = tickets.get(id);
    if (!ticket || ticket.owner !== owner) throw new SourceError('MOVIE_SOURCE_EXPIRED', 'Список файлов устарел. Повторите импорт.', 404);
    let url; let headers = {};
    if (ticket.source.provider === 'yandex') url = (await json(yandexUrl(ticket.source.key, ticket.source.path, 0, true), signal)).href;
    else if (ticket.source.provider === 'google') {
      url = `https://www.googleapis.com/drive/v3/files/${ticket.source.id}?` + new URLSearchParams({ key: googleApiKey, alt: 'media' });
      if (ticket.source.resourceKey) headers = { 'X-Goog-Drive-Resource-Keys': `${ticket.source.id}/${ticket.source.resourceKey}` };
    }
    else url = ticket.source.url;
    const { response } = await request(url, signal, headers);
    const type = mediaType(ticket.name, response.headers.get('content-type'));
    if (!type || type !== ticket.type) { await response.body?.cancel(); throw new SourceError('MOVIE_SOURCE_TYPE', 'Ссылка вернула страницу или неподдерживаемый файл.', 422); }
    const bytes = await readLimited(response, MAX_FILE_BYTES);
    if (!bytes.length) throw new SourceError('MOVIE_SOURCE_EMPTY', 'Файл пустой.', 422);
    const signature = type === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : type === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : type === 'image/webp' ? bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
          : type === 'video/mp4' ? bytes.toString('ascii', 4, 8) === 'ftyp'
            : bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]));
    if (!signature) throw new SourceError('MOVIE_SOURCE_TYPE', 'Содержимое файла не соответствует формату фото или видео.', 422);
    return { bytes, type };
  }
  return {
    list, download,
    async run(owner, action) {
      if (active.has(owner) || active.size >= 2) throw new SourceError('MOVIE_SOURCE_BUSY', 'Импорт уже выполняется. Дождитесь окончания.', 429);
      active.add(owner); try { return await action(); } finally { active.delete(owner); }
    },
  };
}
module.exports = { createMovieSources, SourceError, sourceUrl, mediaType, MAX_FILE_BYTES };
