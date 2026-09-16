const fs = require('node:fs/promises');
const {createWriteStream} = require('node:fs');
const path = require('node:path');
const {Readable} = require('node:stream');
const {pipeline} = require('node:stream/promises');
const {randomUUID} = require('node:crypto');
const types = {'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp','image/gif':'.gif','video/mp4':'.mp4','video/webm':'.webm','video/quicktime':'.mov'};
async function download(url, directory, fetcher = fetch) {
  if (new URL(url).protocol !== 'https:') throw new Error('Для скачивания требуется HTTPS-ссылка');
  const response = await fetcher(url, {signal:AbortSignal.timeout(300000)});
  if (!response.ok) throw new Error(`Скачивание: HTTP ${response.status}. Возможно, ссылка истекла.`);
  if (response.url && new URL(response.url).protocol !== 'https:') throw new Error('Небезопасное перенаправление файла');
  const mime = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
  let extension = types[mime];
  if (!extension && mime === 'application/octet-stream') {
    const candidate=path.extname(new URL(url).pathname).toLowerCase();
    if(Object.values(types).includes(candidate)) extension=candidate;
  }
  if (!extension || !response.body) throw new Error('Сервер не вернул поддерживаемое изображение или видео');
  await fs.mkdir(directory,{recursive:true});
  const target=path.join(directory,`generation-${randomUUID()}${extension}`);
  const temporary=target+'.part';
  try {
    await pipeline(Readable.fromWeb(response.body),createWriteStream(temporary,{flags:'wx'}));
    const {size}=await fs.stat(temporary);
    if (!size) throw new Error('Сервер вернул пустой файл');
    // Exclusive copy prevents overwriting an existing file even on a name collision.
    await fs.copyFile(temporary,target,require('node:fs').constants.COPYFILE_EXCL);
    return {path:target,url,size,savedAt:new Date().toISOString()};
  } finally { await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT') throw error;}); }
}
module.exports={download};
