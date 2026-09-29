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
    let grokRecordId;
    for (let index = 0; index < 55; index++) {
      const recordId = randomUUID();
      if (index === 0) grokRecordId = recordId;
      await pool.query("INSERT INTO media_records(account_id,namespace,id,data) VALUES($1,'history',$2,$3)", [accountId, recordId,
        JSON.stringify({ id: recordId, state: 'success', providerId: 'kie', providerName: 'Kie.ai',
          modelId: index === 0 ? 'kie:grok-imagine-image-2-0/text-to-image' : 'kie:nano-banana-2-lite',
          modelName: index === 0 ? 'Grok Imagine' : 'Nano Banana 2 Lite', kind: 'image',
          ...(index === 0 ? { taskId: 'task-grok-browser' } : {}),
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
    if (process.env.BROWSER_E2E_AUTO_ONLY !== '1') {
    assert.equal(await client.evaluate("Boolean(document.querySelector('.sidebar-profile-link, .sidebar-plans-link, .sidebar-primary-nav [aria-label=\"История расходов\"]'))"), false);
    await client.evaluate("document.querySelector('.account-trigger').click();void 0");
    await client.until("document.querySelector('.account-summary strong')?.textContent === 'Browser E2E'");
    await client.evaluate("document.querySelector('.account-menu-section a[href=\"/app/profile\"]').click();void 0");
    await client.until("location.pathname==='/app/profile' && document.querySelector('.commerce-identity-card')?.textContent.includes('Browser E2E')");
    assert.equal(await client.evaluate("document.querySelector('.account-modal-backdrop') === null"), true);
    await client.evaluate("const input=document.querySelector('#commerce-profile-name');input.value='Browser updated';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.commerce-name-field button').click();void 0");
    await client.until("document.querySelector('.commerce-identity-card')?.textContent.includes('Browser updated')");
    assert.equal((await pool.query('SELECT display_name FROM media_accounts WHERE id=$1', [accountId])).rows[0].display_name, 'Browser updated');
    await client.evaluate(`window.__commerceFetch=window.fetch.bind(window);window.fetch=(input,init)=>{
      const url=new URL(typeof input==='string'?input:input.url,location.origin);
      if(url.pathname==='/api/commerce/offers')return Promise.resolve(new Response(JSON.stringify({result:[{
        id:'browser-package',version:'v1',name:'Browser package',description:'Test offer',creditUnits:450000,
        amountMinor:49000,currency:'RUB',active:true,checkoutMode:'stub'}]}),{status:200,headers:{'Content-Type':'application/json'}}));
      return window.__commerceFetch(input,init)};void 0`);
    await client.evaluate("document.querySelectorAll('.commerce-rail nav button')[1].click();void 0");
    await client.until("location.pathname==='/app/plans' && document.querySelectorAll('.commerce-card').length>0");
    assert.equal(await client.evaluate("document.querySelector('.subscription-dialog') === null"), true);
    await client.evaluate("document.querySelector('.commerce-card > button').click();void 0");
    await client.until("Boolean(document.querySelector('.commerce-checkout .commerce-payment-method'))");
    assert.equal(await client.evaluate("document.querySelectorAll('.commerce-card').length"), 0);
    assert.equal(await client.evaluate("Array.from(document.querySelectorAll('.commerce-payment-method')).every(button=>button.disabled)"), true);
    assert.equal((await pool.query('SELECT count(*)::integer AS count FROM media_orders WHERE account_id=$1', [accountId])).rows[0].count, 0);
    await client.evaluate("document.querySelector('.commerce-back').click();void 0");
    await client.until("document.querySelectorAll('.commerce-card').length>0");
    await client.evaluate("window.fetch=window.__commerceFetch;delete window.__commerceFetch;void 0");
    await client.command('Page.navigate', { url: origin + '/app' });
    await client.until("Boolean(document.querySelector('.composer-body textarea'))");
    await client.evaluate("const field=document.querySelector('.composer-body textarea');field.value='Browser draft persists';field.dispatchEvent(new Event('input',{bubbles:true}));void 0");
    await sleep(1000);
    await client.command('Page.reload');
    await client.until("document.querySelector('.composer-body textarea')?.value==='Browser draft persists'");
    const selectedCodexModel = await client.evaluate("document.querySelector('.model-native-select')?.value");
    const otherCodexModel = await client.evaluate("Array.from(document.querySelectorAll('.model-native-select option')).map(option=>option.value).find(value=>value!==document.querySelector('.model-native-select').value)");
    assert.ok(otherCodexModel, 'the catalog contains another model for selection caching');
    const cachedSource = `content:${randomUUID()}`;
    await client.evaluate(`(async()=>{
      const chatId=JSON.parse(localStorage.getItem('media-studio-workspace')||'null')?.chatId;
      const draft={version:1,active:0,tabs:[{prompt:'Browser draft persists',mode:'image',provider:'codex',codexModel:${JSON.stringify(selectedCodexModel)},sourceFiles:[{ref:${JSON.stringify(cachedSource)},name:'cached.png',type:'image/png'}]}]};
      const response=await fetch('/api/rpc/saveDrafts',{method:'POST',headers:{'Content-Type':'application/json','X-Media-Client':'web','X-Media-User':document.querySelector('meta[name="account-id"]').content},body:JSON.stringify([draft,chatId&&chatId!=='system:recent'?{chatId}:{}])});
      if(!response.ok)throw new Error('Failed to seed source draft');
    })()`);
    await client.command('Page.reload');
    await client.until("document.querySelectorAll('.source-preview').length===1");
    await client.evaluate("document.querySelectorAll('.composer-tabs button')[0].click();void 0");
    await client.until("document.querySelectorAll('.source-preview').length===0 && document.querySelector('.composer-body textarea')?.value==='Browser draft persists'");
    await client.evaluate("document.querySelectorAll('.composer-tabs button')[1].click();void 0");
    await client.until("document.querySelectorAll('.source-preview').length===1");
    await client.evaluate(`{const select=document.querySelector('.model-native-select');select.value=${JSON.stringify(otherCodexModel)};select.dispatchEvent(new Event('change',{bubbles:true}));}void 0`);
    await client.until("document.querySelectorAll('.source-preview').length===0");
    await client.evaluate(`{const select=document.querySelector('.model-native-select');select.value=${JSON.stringify(selectedCodexModel)};select.dispatchEvent(new Event('change',{bubbles:true}));}void 0`);
    await client.until("document.querySelectorAll('.source-preview').length===1");
    await client.evaluate("document.querySelectorAll('.composer-tabs button')[2].click();void 0");
    await client.until("document.querySelectorAll('.source-preview').length===0");
    await client.evaluate("document.querySelectorAll('.composer-tabs button')[1].click();void 0");
    await client.until(`document.querySelectorAll('.source-preview').length===1 && document.querySelector('.model-native-select')?.value===${JSON.stringify(selectedCodexModel)}`);
    await sleep(1000);
    await client.command('Page.reload');
    await client.until("document.querySelectorAll('.source-preview').length===1 && document.querySelector('.composer-body textarea')?.value==='Browser draft persists'");
    const mediaSelections = await client.evaluate(`(async()=>{
      const response=await fetch('/api/rpc/getCatalog',{method:'POST',headers:{'Content-Type':'application/json','X-Media-Client':'web','X-Media-User':document.querySelector('meta[name="account-id"]').content},body:'[]'});
      const models=(await response.json()).result.models.filter(model=>(model.kind||'image')==='image');
      const first=models.find(model=>model.id==='kie:seedream/5-pro-image-to-image');
      const second=models.find(model=>model.id==='kie:seedream/5-lite-image-to-image');
      return {first:first?.id,field:first?.fields.find(field=>field.type==='files')?.key,second:second?.id,
        incompatible:models.find(model=>model.id!==first?.id && model.id!==second?.id && !model.fields?.some(field=>field.type==='files' && field.key==='image_urls'))?.id};
    })()`);
    assert.ok(mediaSelections.first && mediaSelections.field && mediaSelections.second && mediaSelections.incompatible, 'the catalog contains compatible and incompatible image models');
    await client.evaluate(`(async()=>{
      const chatId=JSON.parse(localStorage.getItem('media-studio-workspace')||'null')?.chatId;
      const ref=${JSON.stringify(cachedSource)};
      const draft={version:1,active:0,tabs:[{prompt:'Browser draft persists',mode:'image',provider:'media',mediaModelId:${JSON.stringify(mediaSelections.first)},mediaInput:{[${JSON.stringify(mediaSelections.field)}]:[ref]},sourceFiles:[{ref,name:'cached.png',type:'image/png',fieldKey:${JSON.stringify(mediaSelections.field)}}]}]};
      const response=await fetch('/api/rpc/saveDrafts',{method:'POST',headers:{'Content-Type':'application/json','X-Media-Client':'web','X-Media-User':document.querySelector('meta[name="account-id"]').content},body:JSON.stringify([draft,chatId&&chatId!=='system:recent'?{chatId}:{}])});
      if(!response.ok)throw new Error('Failed to seed media draft');
    })()`);
    await client.command('Page.reload');
    await client.until(`document.querySelectorAll('.source-preview').length===1 && document.querySelector('.model-native-select')?.value===${JSON.stringify(mediaSelections.first)}`);
    await client.evaluate(`{const select=document.querySelector('.model-native-select');select.value=${JSON.stringify(mediaSelections.second)};select.dispatchEvent(new Event('change',{bubbles:true}));}void 0`);
    await client.until(`document.querySelectorAll('.source-preview').length===1 && document.querySelector('.model-native-select')?.value===${JSON.stringify(mediaSelections.second)}`);
    await sleep(1000);
    await client.command('Page.reload');
    await client.until(`document.querySelectorAll('.source-preview').length===1 && document.querySelector('.model-native-select')?.value===${JSON.stringify(mediaSelections.second)}`);
    const liteDraft = await client.evaluate(`(async()=>{
      const chatId=JSON.parse(localStorage.getItem('media-studio-workspace')||'null')?.chatId;
      const response=await fetch('/api/rpc/loadDrafts',{method:'POST',headers:{'Content-Type':'application/json','X-Media-Client':'web','X-Media-User':document.querySelector('meta[name="account-id"]').content},body:JSON.stringify(chatId&&chatId!=='system:recent'?[{chatId}]:[])});
      return (await response.json()).result?.tabs?.[0];
    })()`);
    assert.deepEqual(liteDraft?.mediaInput?.[mediaSelections.field], [cachedSource]);
    await client.evaluate(`{const select=document.querySelector('.model-native-select');select.value=${JSON.stringify(mediaSelections.incompatible)};select.dispatchEvent(new Event('change',{bubbles:true}));}void 0`);
    await client.until("document.querySelectorAll('.source-preview').length===0");
    await client.evaluate(`{const select=document.querySelector('.model-native-select');select.value=${JSON.stringify(mediaSelections.first)};select.dispatchEvent(new Event('change',{bubbles:true}));}void 0`);
    await client.until("document.querySelectorAll('.source-preview').length===1 && document.querySelector('.composer-body textarea')?.value==='Browser draft persists'");
    await sleep(1000);
    await client.command('Page.reload');
    await client.until("document.querySelectorAll('.source-preview').length===1");
    if (process.env.BROWSER_E2E_SELECTION_ONLY === '1') return;
    await client.evaluate("document.querySelector('.sidebar-history-link').click();void 0");
    await client.until("document.querySelectorAll('.history-page .history-item').length===50");
    await client.evaluate("document.querySelector('.history-page-list > .action-button').click();void 0");
    await client.until("document.querySelectorAll('.history-page .history-item').length===55");
    await client.evaluate("document.querySelector('.history-page-back').click();void 0");
    await client.until("Boolean(document.querySelector('.composer-body textarea'))");
    await client.evaluate("document.querySelector('.sidebar-provider-menu').open=true;document.querySelector('.sidebar-provider-option[data-provider=media]').click();void 0");
    await client.until("document.querySelector('.sidebar-provider-option.active')?.dataset.provider==='media'");
    await client.evaluate("const model=document.querySelector('.model-pill select');model.value='kie:nano-banana-2-lite';model.dispatchEvent(new Event('change',{bubbles:true}));const prompt=document.querySelector('.composer-body textarea');prompt.value='Browser retry';prompt.dispatchEvent(new Event('input',{bubbles:true}));void 0");
    await client.evaluate("document.querySelector('.source-preview .source-remove')?.click();void 0");
    await client.until("document.querySelectorAll('.source-preview').length===0");
    await client.until("Boolean(document.querySelector('.aspect-native-select option[value=\"1:1\"]'))");
    await client.evaluate("const ratio=document.querySelector('.aspect-native-select');ratio.value='1:1';ratio.dispatchEvent(new Event('change',{bubbles:true}));void 0");
    await client.until("!document.querySelector('.generate-button').disabled");
    await client.evaluate(`window.__acceptedFetch=window.fetch.bind(window);window.fetch=(input,init)=>{
      const url=new URL(typeof input==='string'?input:input.url,location.origin);
      if(url.pathname==='/api/rpc/createTask')return Promise.resolve(new Response(JSON.stringify({error:'Test rejected before enqueue'}),{status:400,headers:{'Content-Type':'application/json'}}));
      return window.__acceptedFetch(input,init)};document.querySelector('.generate-button').click();void 0`);
    await client.until("Boolean(document.querySelector('.chat-result-item.selected .chat-result-state.state-fail'))");
    await client.evaluate("window.fetch=window.__acceptedFetch;delete window.__acceptedFetch;void 0");
    await client.until("!document.querySelector('.generate-button').disabled");
    await client.evaluate("document.querySelector('.generate-button').click();void 0");
    await client.until("Boolean(document.querySelector('.result-card .panel-heading h2.is-success'))");
    await client.evaluate("{const select=document.querySelector('.model-native-select');select.value='kie:recraft/crisp-upscale';select.dispatchEvent(new Event('change',{bubbles:true}));}void 0");
    await client.until("document.querySelector('.source-strip input[type=file]') !== null && document.querySelector('.composer-body textarea') === null");
    await client.evaluate(`{const input=document.querySelector('.source-strip input[type=file]');const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/sZkAAAAASUVORK5CYII='),c=>c.charCodeAt(0));const transfer=new DataTransfer();transfer.items.add(new File([bytes],'test.png',{type:'image/png'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));}void 0`);
    await client.until("document.querySelectorAll('.source-preview').length===1 && !document.querySelector('.form-error')?.textContent.includes('image')");
    await client.evaluate("{const select=document.querySelector('.model-native-select');select.value='kie:grok-imagine-image-2-0/segment-edit';select.dispatchEvent(new Event('change',{bubbles:true}));}void 0");
    await client.until(`document.querySelector('.task-reference-field select option[value="${grokRecordId}"]') !== null`);
    await client.evaluate(`{const select=document.querySelector('.task-reference-field select');select.value='${grokRecordId}';select.dispatchEvent(new Event('change',{bubbles:true}));}void 0`);
    await client.until(`document.querySelector('.task-reference-field input')?.value==='${grokRecordId}'`);
    await client.evaluate("{const prompt=document.querySelector('.composer-body textarea');prompt.value='Edit the picture';prompt.dispatchEvent(new Event('input',{bubbles:true}));}void 0");
    await client.until("!document.querySelector('.generate-button').disabled");
    await client.evaluate("document.querySelector('.generate-button').click();void 0");
    let referenceSubmission;
    for (let attempt = 0; attempt < 100 && !referenceSubmission; attempt++) {
      referenceSubmission = (await pool.query("SELECT data FROM media_records WHERE account_id=$1 AND namespace='history' AND data->>'modelId'='kie:grok-imagine-image-2-0/segment-edit' ORDER BY data->>'createdAt' DESC LIMIT 1", [accountId])).rows[0];
      if (!referenceSubmission) await sleep(100);
    }
    assert.equal(referenceSubmission?.data?.input?.task_id, 'task-grok-browser', JSON.stringify({ referenceSubmission, form: await client.evaluate("({error:document.querySelector('.form-error')?.textContent,button:document.querySelector('.generate-button')?.disabled,task:document.querySelector('.task-reference-field input')?.value})") }));
    await client.evaluate("{const select=document.querySelector('.model-native-select');select.value='kie:grok-imagine-image-2-0/segment-map';select.dispatchEvent(new Event('change',{bubbles:true}));}void 0");
    await client.until("document.querySelector('.select-pill select option[value=\"1\"]') !== null");
    await client.evaluate("{const select=document.querySelector('.select-pill select');select.value='1';select.dispatchEvent(new Event('change',{bubbles:true}));}void 0");
    await client.until("document.querySelector('.source-strip input[type=file]') !== null");
    await client.evaluate("document.querySelectorAll('.composer-tabs button')[2].click();void 0");
    await client.until("document.querySelector('.model-native-select option[value=\"kie:wan/2-6-image-to-video\"]') !== null");
    await client.evaluate("{const select=document.querySelector('.model-native-select');select.value='kie:wan/2-6-image-to-video';select.dispatchEvent(new Event('change',{bubbles:true}));}void 0");
    await client.until("document.querySelector('.source-strip input[type=file]') !== null");
    await client.evaluate(`{const prompt=document.querySelector('.composer-body textarea');prompt.value='A moving scene';prompt.dispatchEvent(new Event('input',{bubbles:true}));const input=document.querySelector('.source-strip input[type=file]');const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/sZkAAAAASUVORK5CYII='),c=>c.charCodeAt(0));const transfer=new DataTransfer();transfer.items.add(new File([bytes],'video-source.png',{type:'image/png'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));}void 0`);
    await client.until("document.querySelectorAll('.source-preview').length===1 && !document.querySelector('.form-error')?.textContent.includes('Референсные изображения')");
    await client.evaluate("{const select=document.querySelector('.model-native-select');select.value='kie:pixverse-v6/reference-to-video';select.dispatchEvent(new Event('change',{bubbles:true}));}void 0");
    await client.until("document.querySelector('.schema-fields .schema-field-items > button') !== null");
    await client.evaluate("document.querySelector('.schema-fields .schema-field-items > button').click();void 0");
    await client.until("document.querySelector('.schema-fields input[type=file]') !== null");
    await client.evaluate("document.querySelectorAll('.composer-tabs button')[3].click();void 0");
    await client.until("document.querySelector('.model-native-select option[value=\"kie:google/gemini-2-5-pro-tts\"]') !== null");
    await client.evaluate("{const select=document.querySelector('.model-native-select');select.value='kie:google/gemini-2-5-pro-tts';select.dispatchEvent(new Event('change',{bubbles:true}));}void 0");
    await client.until("document.querySelectorAll('.schema-fields .schema-field-items > button').length===2 && document.querySelector('.composer-body textarea')===null");
    const orderId = randomUUID();
    const offer = { id: 'browser-credits', version: 'v1', name: 'Browser test credits', description: '', amountMinor: 100, currency: 'RUB', creditUnits: 1000 };
    await pool.query(`INSERT INTO media_orders(id,account_id,status,product_id,product_version,offer_snapshot,amount_minor,currency,credit_units,checkout_key,checkout_hash)
      VALUES($1,$2,'fulfilled',$3,$4,$5,$6,$7,$8,$9,$10)`, [orderId, accountId, offer.id, offer.version, offer, offer.amountMinor, offer.currency,
      offer.creditUnits, `browser-return-${orderId}`, payloadHash({ offerId: offer.id, offerVersion: offer.version })]);
    await client.command('Page.navigate', { url: `${origin}/app?order=${orderId}` });
    await client.until("location.pathname==='/app/plans' && !new URL(location.href).searchParams.has('order') && document.querySelector('.commerce-feedback[role=status]')?.textContent.length > 0");
    assert.equal(await client.evaluate("document.querySelector('.subscription-dialog') === null"), true);
    }
    const adminId = randomUUID(), adminToken = randomBytes(32).toString('base64url');
    await pool.query("INSERT INTO media_accounts(id,display_name,role) VALUES($1,'Auto route admin','admin')", [adminId]);
    await pool.query('INSERT INTO media_wallets(account_id,balance) VALUES($1,5000)', [adminId]);
    await pool.query("INSERT INTO media_sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [hash(adminToken), adminId]);
    assert.equal((await client.command('Network.setCookie', { name: 'media-session', value: adminToken, url: origin, httpOnly: true, sameSite: 'Lax' })).success, true);
    await client.command('Page.addScriptToEvaluateOnNewDocument', { source: `
      const originalFetch = window.fetch.bind(window);
      window.fetch = (input, init) => new URL(typeof input === 'string' ? input : input.url, location.origin).pathname === '/api/apimart/models'
        ? Promise.resolve(new Response(JSON.stringify({ models: [{ id: 'gemini-3-pro-image-preview', name: 'gemini-3-pro-image-preview',
          kind: 'image', fields: [], promptRequired: true }, { id: 'gemini-3.1-flash-lite-image', name: 'gemini-3.1-flash-lite-image',
          kind: 'image', fields: [], promptRequired: true }, { id: 'apimart-only-test', name: 'APIMart only test',
          kind: 'image', fields: [], promptRequired: true }, { id: 'gpt-image-2', name: 'GPT Image 2',
          kind: 'image', fields: [], promptRequired: true }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
        : originalFetch(input, init);
    ` });
    await client.command('Page.navigate', { url: origin + '/app' });
    await client.until("document.querySelector('.sidebar-provider-option[data-provider=auto]')?.disabled===false");
    assert.equal(await client.evaluate("document.querySelector('.sidebar-provider-option[data-provider=auto]')?.classList.contains('active')"), true);
    await client.evaluate("document.querySelector('.sidebar-provider-option[data-provider=codex]').click();void 0");
    await client.until("document.querySelector('.sidebar-provider-option[data-provider=codex]')?.classList.contains('active')");
    await sleep(1200);
    await client.command('Page.reload');
    await client.until("document.querySelector('.sidebar-provider-option[data-provider=codex]')?.classList.contains('active')");
    await client.evaluate("window.__autoQuoteFetch=window.fetch.bind(window);window.fetch=(input,init)=>{if(new URL(typeof input==='string'?input:input.url,location.origin).pathname!=='/api/auto/quote')return window.__autoQuoteFetch(input,init);const nano=JSON.parse(init.body).modelId==='kie:nano-banana-pro';return Promise.resolve(new Response(JSON.stringify(nano?{selected:{providerId:'apimart',costUsd:0.03,nativeCredits:0.3,credits:0.3},offers:[{providerId:'kie',modelId:'kie:nano-banana-pro',costUsd:0.09,providerCredits:18,usdPerProviderCredit:0.005,credits:18},{providerId:'apimart',modelId:'gemini-3-pro-image-preview',costUsd:0.03,providerCredits:0.3,usdPerProviderCredit:0.1,credits:0.3}]}:{selected:{providerId:'apimart',costUsd:0.012,nativeCredits:0.12,credits:0.12},offers:[{providerId:'kie',modelId:'kie:gpt-image-2-text-to-image',costUsd:0.02,providerCredits:4,usdPerProviderCredit:0.005,credits:20},{providerId:'apimart',modelId:'gpt-image-2',costUsd:0.012,providerCredits:0.12,usdPerProviderCredit:0.1,credits:0.12}]}),{status:200,headers:{'Content-Type':'application/json'}}))};document.querySelector('.sidebar-provider-option[data-provider=auto]').click();void 0");
    await client.until("document.querySelector('.sidebar-provider-option.active')?.dataset.provider==='auto' && document.querySelector('.model-picker-label')?.textContent==='Модели с ID Kie и APIMart'");
    assert.equal(await client.evaluate("document.querySelectorAll('.auto-service-menus button').length"), 0);
    assert.equal(await client.evaluate("document.querySelector('.model-native-select option[value=\"apimart:gemini-3.1-flash-lite-image\"]') === null"), true);
    const autoOptions = await client.evaluate("Array.from(document.querySelectorAll('.model-native-select option'), option=>({value:option.value,label:option.textContent.trim()}))");
    assert.ok(autoOptions.length > 1);
    assert.ok(autoOptions.some(option => option.value.startsWith('kie:')));
    assert.equal(new Set(autoOptions.map(option => option.label.toLowerCase())).size, autoOptions.length);
    assert.equal(autoOptions.filter(option => option.value === 'kie:gpt-image-2-text-to-image').length, 1);
    assert.equal(autoOptions.filter(option => option.value === 'kie:nano-banana-pro').length, 1);
    assert.equal(await client.evaluate("document.querySelector('.sidebar-provider-option.active')?.dataset.provider"), 'auto');
    await client.evaluate("window.__autoQuoteMockFetch=window.fetch.bind(window);window.fetch=(input,init)=>new URL(typeof input==='string'?input:input.url,location.origin).pathname==='/api/auto/quote'?Promise.resolve(new Response(JSON.stringify({selected:null,offers:[{providerId:'kie',modelId:'kie:example',unavailable:true,reason:'Kie tariff unavailable'},{providerId:'apimart',modelId:'example',credits:0.32,costUsd:0.032,unavailable:true,reason:'APIMart balance unavailable'}]}),{status:200,headers:{'Content-Type':'application/json'}})):window.__autoQuoteMockFetch(input,init);{const el=document.querySelector('.composer-body textarea');el.value='Unavailable route test';el.dispatchEvent(new Event('input',{bubbles:true}));}void 0");
    await client.until("document.querySelector('.auto-route-note')?.textContent.includes('APIMart balance unavailable')");
    assert.equal(await client.evaluate("document.querySelector('.generate-button').disabled"), true);
    await client.evaluate("document.querySelector('.auto-route-details-button').click();void 0");
    await client.until("document.querySelectorAll('.auto-route-table tbody tr').length===2");
    assert.match(await client.evaluate("document.querySelector('.auto-route-table').textContent"), /Kie tariff unavailable.*0[,.]32.*APIMart balance unavailable/s);
    await client.evaluate("document.querySelector('.auto-route-dialog .dialog-close').click();window.fetch=window.__autoQuoteMockFetch;void 0");

    await client.evaluate("{const select=document.querySelector('.model-native-select');select.value='kie:gpt-image-2-text-to-image';select.dispatchEvent(new Event('change',{bubbles:true}));}void 0");
    await client.until("document.querySelector('.model-native-select')?.value==='kie:gpt-image-2-text-to-image'");
    await client.evaluate("const prompt=document.querySelector('.composer-body textarea');prompt.value='UI auto route';prompt.dispatchEvent(new Event('input',{bubbles:true}));void 0");
    await client.until("document.querySelector('.auto-route-note')?.textContent.includes('APIMart')");
    assert.match(await client.evaluate("document.querySelector('.auto-route-note').textContent"), /(?:Автомат предварительно выбрал|Automatic preliminary selection): APIMart.*\$0[,.]012/);
    assert.match(await client.evaluate("document.querySelector('.generate-button').textContent"), /0[,.]12.*0[,.]012/);
    await client.evaluate("document.querySelector('.auto-route-details-button').click();void 0");
    await client.until("document.querySelectorAll('.auto-route-table tbody tr').length===2");
    assert.deepEqual(await client.evaluate("Array.from(document.querySelectorAll('.auto-route-table tbody tr'), row=>row.classList.contains('selected'))"), [false, true]);
    assert.deepEqual(await client.evaluate("Array.from(document.querySelectorAll('.auto-route-published-tariff'), cell=>cell.textContent.trim()!=='—')"), [true, true]);
    assert.deepEqual(await client.evaluate("Array.from(document.querySelectorAll('.auto-route-table tbody tr'), row=>Array.from(row.cells, cell=>cell.textContent.trim().replace(',', '.')).slice(2,5))"),
      [['4', '$0.005', '$0.02'], ['0.12', '$0.1', '$0.012']]);
    assert.match(await client.evaluate("document.querySelectorAll('.auto-route-table tbody tr')[0].textContent"), /Kie\.ai.*20.*\$0[,.]02/s);
    assert.match(await client.evaluate("document.querySelectorAll('.auto-route-table tbody tr')[1].textContent"), /APIMart.*0[,.]12.*\$0[,.]012/s);
    await client.evaluate("document.querySelector('.auto-route-dialog .dialog-close').click();void 0");
    await client.until("!document.querySelector('.auto-route-dialog')");
    await client.evaluate("{const select=document.querySelector('.model-native-select');select.value='kie:nano-banana-pro';select.dispatchEvent(new Event('change',{bubbles:true}));}void 0");
    await client.until("document.querySelector('.model-native-select')?.value==='kie:nano-banana-pro' && /0[,.]03/.test(document.querySelector('.auto-route-note')?.textContent||'') && document.querySelector('.auto-route-details-button')");
    await client.evaluate("document.querySelector('.auto-route-details-button').click();void 0");
    await client.until("document.querySelectorAll('.auto-route-table tbody tr').length===2");
    assert.match(await client.evaluate("document.querySelector('.auto-route-dialog-model').textContent"), /Nano Banana Pro/);
    assert.match(await client.evaluate("document.querySelectorAll('.auto-route-table tbody tr')[0].textContent"), /Nano Banana Pro.*18.*\$0[,.]09/s);
    assert.match(await client.evaluate("document.querySelectorAll('.auto-route-table tbody tr')[1].textContent"), /Nano Banana Pro.*gemini-3-pro-image-preview.*0[,.]3.*\$0[,.]03/s);
    await client.evaluate("document.querySelector('.auto-route-dialog .dialog-close').click();const select=document.querySelector('.model-native-select');select.value='kie:gpt-image-2-text-to-image';select.dispatchEvent(new Event('change',{bubbles:true}));void 0");
    await client.evaluate("{window.fetch=(input,init)=>new URL(typeof input==='string'?input:input.url,location.origin).pathname==='/api/auto/quote'?Promise.resolve(new Response(JSON.stringify({selected:{providerId:'kie',costUsd:0.005,credits:19.244},offers:[{providerId:'kie',modelId:'kie:gpt-image-2-text-to-image',costUsd:0.005,credits:19.244}]}),{status:200,headers:{'Content-Type':'application/json'}})):window.__autoQuoteFetch(input,init);const prompt=document.querySelector('.composer-body textarea');prompt.value='UI auto route Kie';prompt.dispatchEvent(new Event('input',{bubbles:true}));}void 0");
    await client.until("document.querySelector('.auto-route-note')?.textContent.includes('Kie') && /19[,.]244.*0[,.]005/.test(document.querySelector('.generate-button')?.textContent||'')");
    await sleep(1000);
    await client.command('Page.reload');
    await client.until("document.querySelector('.sidebar-provider-option.active')?.dataset.provider==='auto'");
    await client.evaluate("document.querySelector('.sidebar-provider-option[data-provider=media]').click();void 0");
    await client.until("document.querySelector('.sidebar-provider-option.active')?.dataset.provider==='media' && !document.querySelector('.auto-route-note')");
    console.log('Browser E2E passed: authenticated studio, draft reload, checkout return and automatic provider selection');
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
