// Browser smoke against isolated PostgreSQL. No external provider credentials or requests.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomBytes, randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { start } = require('../server');
const { loadConfig } = require('../src/server/config');
const { hash } = require('../src/auth/service');
const { payloadHash } = require('../src/payments/contracts');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function browserTarget() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const pages = await (await fetch('http://127.0.0.1:9223/json/list')).json();
      const page = pages.find(item => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(100);
  }
  throw new Error('Chromium CDP did not start');
}

async function cdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error('CDP connection failed')); });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const response = JSON.parse(event.data);
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    if (response.error) request.reject(new Error(response.error.message));
    else request.resolve(response.result);
  };
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result?.value;
  };
  const until = async expression => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(expression)) return;
      await sleep(100);
    }
    const detail = await evaluate("({model:document.querySelector('.model-pill select')?.value,button:document.querySelector('.generate-button')?.textContent,quote:document.querySelector('.quote')?.textContent,error:document.querySelector('.form-error')?.textContent,body:document.body.innerText.slice(-500)})");
    throw new Error(`Browser condition timed out: ${expression}: ${JSON.stringify(detail)}`);
  };
  return { command, evaluate, until, close: () => socket.close() };
}

async function main() {
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
  const id = randomUUID();
  const directory = path.resolve(__dirname, `../data/browser-e2e-${id}`);
  const profile = path.resolve('/tmp', `browser-e2e-${id}`);
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 });
  let runtime, browser, client;
  try {
    const config = { ...loadConfig({ MEDIA_PORT: '0', MEDIA_AUTH_ENABLED: 'true' }), dataDirectory: directory };
    const tariffFetcher = async () => new Response(JSON.stringify({ code: 200, data: { pages: 1, records: [
      { modelDescription: 'nano-banana-2-lite, 1k', creditPrice: '1', creditUnit: 'per image',
        anchor: 'https://kie.ai/nano-banana-2-lite', interfaceType: 'image', provider: 'Google' },
    ] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    runtime = await start({ config, pool, authProviders: new Map(), startupChecks: false, tariffFetcher, provider: {
      id: 'kie', isConfigured: () => true, upload: async () => 'https://example.test/source',
      create: async () => ({ taskId: 'browser-e2e' }), poll: async () => ({ state: 'success', resultJson: '{"resultUrls":[]}' }),
      balance: async () => 100,
    } });
    const accountId = randomUUID(), token = randomBytes(32).toString('base64url');
    await pool.query("INSERT INTO media_accounts(id,display_name) VALUES($1,'Browser E2E')", [accountId]);
    await pool.query('INSERT INTO media_wallets(account_id,balance) VALUES($1,5000)', [accountId]);
    await pool.query("INSERT INTO media_sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [hash(token), accountId]);
    for (let index = 0; index < 55; index++) {
      const recordId = randomUUID();
      await pool.query("INSERT INTO media_records(account_id,namespace,id,data) VALUES($1,'history',$2,$3)", [accountId, recordId,
        JSON.stringify({ id: recordId, state: 'success', providerId: 'kie', providerName: 'Kie.ai',
          modelId: 'kie:nano-banana-2-lite', modelName: 'Nano Banana 2 Lite', kind: 'image',
          input: { prompt: `Browser history ${index}` }, createdAt: new Date(Date.now() - index * 1000).toISOString() })]);
    }
    const origin = `http://localhost:${runtime.server.address().port}`;
    browser = spawn('/usr/bin/chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--no-first-run', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9223',
      `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
    client = await cdp(await browserTarget());
    await client.command('Network.enable');
    assert.equal((await client.command('Network.setCookie', { name: 'media-session', value: token, url: origin, httpOnly: true, sameSite: 'Lax' })).success, true);
    await client.command('Page.enable');
    await client.command('Page.navigate', { url: origin + '/app' });
    await client.until("Boolean(document.querySelector('.studio-main .composer-body textarea'))");
    assert.equal(await client.evaluate("document.querySelector('.studio-main') !== null"), true);
    await client.evaluate("document.querySelector('.sidebar-profile-link').click();void 0");
    await client.until("location.pathname==='/app/profile' && document.querySelector('.commerce-identity-card')?.textContent.includes('Browser E2E')");
    assert.equal(await client.evaluate("document.querySelector('.account-modal-backdrop') === null"), true);
    await client.evaluate("const input=document.querySelector('#commerce-profile-name');input.value='Browser updated';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.commerce-name-field button').click();void 0");
    await client.until("document.querySelector('.commerce-identity-card')?.textContent.includes('Browser updated')");
    assert.equal((await pool.query('SELECT display_name FROM media_accounts WHERE id=$1', [accountId])).rows[0].display_name, 'Browser updated');
    await client.evaluate("document.querySelectorAll('.commerce-rail nav button')[1].click();void 0");
    await client.until("location.pathname==='/app/plans' && Boolean(document.querySelector('.commerce-shell'))");
    assert.equal(await client.evaluate("document.querySelector('.subscription-dialog') === null"), true);
    await client.command('Page.navigate', { url: origin + '/app' });
    await client.until("Boolean(document.querySelector('.composer-body textarea'))");
    await client.evaluate("const field=document.querySelector('.composer-body textarea');field.value='Browser draft persists';field.dispatchEvent(new Event('input',{bubbles:true}));void 0");
    await sleep(1000);
    await client.command('Page.reload');
    await client.until("document.querySelector('.composer-body textarea')?.value==='Browser draft persists'");
    await client.evaluate("document.querySelector('.sidebar-history-link').click();void 0");
    await client.until("document.querySelectorAll('.history-page .history-item').length===50");
    await client.evaluate("document.querySelector('.history-page-list > .action-button').click();void 0");
    await client.until("document.querySelectorAll('.history-page .history-item').length===55");
    await client.evaluate("document.querySelector('.history-page-back').click();void 0");
    await client.until("Boolean(document.querySelector('.composer-body textarea'))");
    await client.evaluate("document.querySelector('.sidebar-provider-menu').open=true;document.querySelector('.sidebar-provider-option[data-provider=media]').click();void 0");
    await client.until("document.querySelector('.sidebar-provider-option.active')?.dataset.provider==='media'");
    await client.evaluate("const model=document.querySelector('.model-pill select');model.value='kie:nano-banana-2-lite';model.dispatchEvent(new Event('change',{bubbles:true}));const prompt=document.querySelector('.composer-body textarea');prompt.value='Browser retry';prompt.dispatchEvent(new Event('input',{bubbles:true}));void 0");
    await client.until("Boolean(document.querySelector('.aspect-native-select option[value=\"1:1\"]'))");
    await client.evaluate("const ratio=document.querySelector('.aspect-native-select');ratio.value='1:1';ratio.dispatchEvent(new Event('change',{bubbles:true}));void 0");
    await client.until("!document.querySelector('.generate-button').disabled");
    await client.evaluate(`window.__acceptedFetch=window.fetch.bind(window);window.fetch=(input,init)=>{
      const url=new URL(typeof input==='string'?input:input.url,location.origin);
      if(url.pathname==='/api/rpc/createTask')return Promise.resolve(new Response(JSON.stringify({error:'Test rejected before enqueue'}),{status:400,headers:{'Content-Type':'application/json'}}));
      return window.__acceptedFetch(input,init)};document.querySelector('.generate-button').click();void 0`);
    await client.until("Boolean(document.querySelector('.chat-result-item.selected .chat-result-state.state-fail'))");
    await client.evaluate("window.fetch=window.__acceptedFetch;delete window.__acceptedFetch;document.querySelector('.generate-button').click();void 0");
    await client.until("Boolean(document.querySelector('.result-card .panel-heading h2.is-success'))");
    const orderId = randomUUID();
    const offer = { id: 'browser-credits', version: 'v1', name: 'Browser test credits', description: '', amountMinor: 100, currency: 'RUB', creditUnits: 1000 };
    await pool.query(`INSERT INTO media_orders(id,account_id,status,product_id,product_version,offer_snapshot,amount_minor,currency,credit_units,checkout_key,checkout_hash)
      VALUES($1,$2,'fulfilled',$3,$4,$5,$6,$7,$8,$9,$10)`, [orderId, accountId, offer.id, offer.version, offer, offer.amountMinor, offer.currency,
      offer.creditUnits, `browser-return-${orderId}`, payloadHash({ offerId: offer.id, offerVersion: offer.version })]);
    await client.command('Page.navigate', { url: `${origin}/app?order=${orderId}` });
    await client.until("location.pathname==='/app/plans' && !new URL(location.href).searchParams.has('order') && document.querySelector('.commerce-feedback[role=status]')?.textContent.length > 0");
    assert.equal(await client.evaluate("document.querySelector('.subscription-dialog') === null"), true);
    console.log('Browser E2E passed: authenticated studio, draft reload, older history page, rejected submit and retry, checkout return');
  } finally {
    client?.close();
    if (browser && browser.exitCode === null && browser.signalCode === null) {
      browser.kill('SIGTERM');
      await Promise.race([once(browser, 'exit'), sleep(5000)]);
      if (browser.exitCode === null && browser.signalCode === null) { browser.kill('SIGKILL'); await once(browser, 'exit'); }
    }
    if (runtime) await runtime.close(); else await pool.end();
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
