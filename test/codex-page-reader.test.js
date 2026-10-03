const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readPublicPage } = require(path.resolve('src/services/codex-page-reader'));
const browserAvailable = fs.existsSync('/usr/bin/chromium');

test('Public reader renders JavaScript and blocks POST, private resources and private redirects', { skip: !browserAvailable }, async () => {
  const calls = [];
  const read = await readPublicPage('https://example.com/', { fetchPage: async (url, signal, lookup, request, headers) => {
    calls.push(url.href);
    assert.equal(headers.Cookie, undefined);
    assert.equal(headers.Authorization, undefined);
    if (url.pathname === '/') return new Response('<html><head><title>Rendered fixture</title></head><body><main>Loading</main><script src="/app.js"></script></body></html>',
      { headers: { 'content-type': 'text/html' } });
    if (url.pathname === '/redirect') return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } });
    if (url.pathname === '/app.js') return new Response(`
      fetch('https://127.0.0.1/private').catch(()=>{});
      fetch('/write', {method:'POST',body:'must never be sent'}).catch(()=>{});
      fetch('/redirect').catch(()=>{});
      setTimeout(()=>{document.querySelector('main').innerText='JavaScript rendered public website content. '+ 'Visible text '.repeat(20);},150);
    `, { headers: { 'content-type': 'text/javascript' } });
    return new Response('', { status: 404 });
  } });
  assert.equal(read.status, 200);
  assert.equal(read.title, 'Rendered fixture');
  assert.match(read.text, /JavaScript rendered public website content/);
  assert.ok(calls.includes('https://example.com/app.js'));
  assert.ok(calls.includes('https://example.com/redirect'));
  assert.ok(!calls.some(url => /127\.0\.0\.1|\/write/.test(url)));
});

test('Public reader cancels navigation and cleans up when its caller stops', { skip: !browserAvailable }, async () => {
  const controller = new AbortController();
  const reading = readPublicPage('https://example.com/', { signal: controller.signal,
    fetchPage: (url, signal) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      controller.abort();
    }) });
  await assert.rejects(reading, /cancel|timed out|stopped|abort/i);
});
