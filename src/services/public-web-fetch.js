const { isIP } = require('node:net');
const { lookup } = require('node:dns/promises');
const https = require('node:https');
const { Readable } = require('node:stream');

function publicResultUrl(value) {
  const url = new URL(value);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password || !host || host === 'localhost'
    || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('Недопустимый адрес результата');
  const kind = isIP(host);
  if (kind === 6) {
    const first = Number.parseInt(host.split(':')[0], 16);
    if (!Number.isInteger(first) || first < 0x2000 || first > 0x3fff) throw new Error('Недопустимый адрес результата');
  }
  if (kind === 4) {
    const [a, b] = host.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19)))
      throw new Error('Недопустимый адрес результата');
  }
  return url;
}

async function fetchPublicResult(target, signal, lookupImpl = lookup, requestImpl = https.request, requestHeaders = {}) {
  const url = publicResultUrl(target);
  let selected;
  if (!isIP(url.hostname)) {
    const addresses = await lookupImpl(url.hostname, { all: true });
    if (!addresses.length || addresses.some(item => {
      try { publicResultUrl(`https://${item.family === 6 ? `[${item.address}]` : item.address}/`); return false; }
      catch { return true; }
    })) throw new Error('DNS результата указывает на недопустимый адрес');
    selected = addresses[0];
  }
  return new Promise((resolve, reject) => {
    const request = requestImpl(url, {
      signal, headers: requestHeaders,
      ...(selected ? { lookup: (_host, options, callback) => options?.all
        ? callback(null, [selected]) : callback(null, selected.address, selected.family) } : {}),
    }, incoming => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) value.forEach(item => headers.append(key, item));
        else if (value != null) headers.set(key, value);
      }
      resolve(new Response([204, 304].includes(incoming.statusCode) ? null : Readable.toWeb(incoming),
        { status: incoming.statusCode, headers }));
    });
    request.once('error', reject);
    request.end();
  });
}
module.exports = { publicResultUrl, fetchPublicResult };
