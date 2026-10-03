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
const { createCodexWorker } = require('../src/services/codex-worker');
const { saveModelConfig } = require('../src/services/service-model-configs');
const modelRoutes = require('../config/model-routes.json');

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
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result?.value;
  };
  const until = async expression => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(expression)) return;
      await sleep(100);
    }
    const detail = await evaluate("({model:document.querySelector('.model-pill select')?.value,button:document.querySelector('.generate-button')?.textContent,quote:document.querySelector('.quote')?.textContent,error:document.querySelector('.form-error')?.textContent,capture:window.__lastPreviewCapture?.getTracks().map(t=>({kind:t.kind,state:t.readyState,settings:t.getSettings()})),body:document.body.innerText.slice(-500)})");
    throw new Error(`Browser condition timed out: ${expression}: ${JSON.stringify(detail)}`);
  };
  return { command, evaluate, until, close: () => socket.close() };
}

async function saveMovieArtifact(client, selector, name) {
  if (!process.env.MOVIE_ARTIFACT_DIR) return;
  const encoded = await client.evaluate(`(async()=>{const bytes=new Uint8Array(await(await fetch(document.querySelector(${JSON.stringify(selector)}).href)).arrayBuffer());let text='';for(let offset=0;offset<bytes.length;offset+=8192)text+=String.fromCharCode(...bytes.subarray(offset,offset+8192));return btoa(text);})()`);
  await fs.mkdir(process.env.MOVIE_ARTIFACT_DIR, { recursive: true });
  await fs.writeFile(path.join(process.env.MOVIE_ARTIFACT_DIR, name), Buffer.from(encoded, 'base64'));
}

async function main() {
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
  const id = randomUUID();
  const directory = path.resolve(__dirname, `../data/browser-e2e-${id}`);
  const profile = path.resolve('/tmp', `browser-e2e-${id}`);
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 });
  let runtime, browser, client, codexWorker;
  try {
    const config = { ...loadConfig({ MEDIA_PORT: '0', MEDIA_AUTH_ENABLED: 'true' }), dataDirectory: directory };
    // Draft tests need a catalog through the real worker HTTP boundary.
    // The injected executor never calls an external provider.
    codexWorker = createCodexWorker(async input => {
      if (process.env.BROWSER_E2E_MOVIE_ONLY === '1' && input.kind === 'text' && input.prompt.includes('TASK_DATA=')) {
        const data = JSON.parse(input.prompt.split('TASK_DATA=')[1]);
        await sleep(data.script === 'STOP_PLAN_TEST' ? 3000 : 500);
        if (data.script === 'INVALID_PLAN_TEST') return JSON.stringify({ scenes: [{ sourceId: 'nonexistent', title: 'Invalid', seconds: 3 }] });
        const image = data.materials.find(item => item.kind === 'image');
        const video = data.materials.find(item => item.kind === 'video');
        assert.ok(image && video);
        return JSON.stringify({ scenes: [{ sourceId: null, title: 'Отпуск', seconds: 1 }, { sourceId: video.id, title: 'Клип', seconds: 1 }, { sourceId: image.id, title: 'Фото', seconds: 1 }, { sourceId: image.id, title: 'Финал', seconds: 1 }] });
      }
      throw new Error('Unexpected Codex generation in browser smoke');
    },
      { resultDirectory: path.join(directory, 'codex-results') });
    await new Promise(resolve => codexWorker.listen(0, '127.0.0.1', resolve));
    config.codex = { ...config.codex, embedded: false, url: `http://127.0.0.1:${codexWorker.address().port}` };
    const schemaFixtures = new Set(['kie:grok-imagine-image-2-0/segment-edit', 'kie:grok-imagine-image-2-0/segment-map',
      'kie:google/gemini-2-5-pro-tts', 'kie:wan/2-6-image-to-video', 'kie:pixverse-v6/reference-to-video', 'kie:omnihuman-1-5',
      'kie:ai-music-api/replace-section', 'kie:ai-music-api/separate-vocals']);
    config.pricing = { ...config.pricing, models: { ...config.pricing.models,
      'kie:grok-imagine-image-2-0/segment-edit': { baseUnits: 1000 } } };
    const tariffFetcher = async () => new Response(JSON.stringify({ code: 200, data: { pages: 1, records: [
      { modelDescription: 'nano-banana-2-lite, 1k', creditPrice: '1', creditUnit: 'per image',
        anchor: 'https://kie.ai/nano-banana-2-lite', interfaceType: 'image', provider: 'Google' },
    ] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    runtime = await start({ config, pool, authProviders: new Map(), startupChecks: false, tariffFetcher, provider: {
      id: 'kie', isConfigured: () => true, upload: async () => 'https://example.test/source',
      create: async () => ({ taskId: 'browser-e2e' }), poll: async () => ({ state: 'success', resultJson: '{"resultUrls":[]}' }),
      balance: async () => 100,
    } });
    // Publish synthetic schema-test rows only in the isolated test database.
    // Production catalog legitimately excludes rows without published tariffs.
    await saveModelConfig(pool, { ...modelRoutes, version: 'browser-schema-fixtures', models: modelRoutes.models.map(row =>
      schemaFixtures.has(row.providers.kie) ? { ...row, publishedTariffs: { ...row.publishedTariffs, kie: '1 test credit' } } : row) });
    const accountId = randomUUID(), token = randomBytes(32).toString('base64url');
    await pool.query("INSERT INTO media_accounts(id,display_name,role) VALUES($1,'Browser E2E',$2)",
      [accountId, process.env.BROWSER_E2E_OMNIHUMAN_ONLY === '1' ? 'admin' : 'user']);
    await pool.query('INSERT INTO media_wallets(account_id,balance) VALUES($1,$2)', [accountId, process.env.BROWSER_E2E_MOVIE_ONLY === '1' ? 500000 : 5000]);
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
      ...(process.env.BROWSER_E2E_MOVIE_ONLY === '1' ? ['--window-size=1600,1000', '--auto-select-tab-capture-source-by-title=AI Media Client', '--enable-usermedia-screen-capturing', '--autoplay-policy=no-user-gesture-required'] : []),
      '--no-first-run', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9223',
      `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
    client = await cdp(await browserTarget());
    await client.command('Network.enable');
    assert.equal((await client.command('Network.setCookie', { name: 'media-session', value: token, url: origin, httpOnly: true, sameSite: 'Lax' })).success, true);
    await client.command('Page.enable');
    await client.command('Page.navigate', { url: origin + '/app' });
    await client.until("Boolean(document.querySelector('.studio-main .composer-body textarea'))");
    assert.equal(await client.evaluate("document.querySelector('.studio-main') !== null"), true);
    if (process.env.BROWSER_E2E_MODEL_ACCESS_ONLY === '1') {
      await client.until("document.querySelectorAll('.model-native-select option').length > 1");
      assert.equal(await client.evaluate("document.querySelector('.sidebar-provider-menu')"), null);
      await client.until("Boolean(document.querySelector('.model-native-select option[value^=\"codex|\"]')) && Boolean(document.querySelector('.model-native-select option[value^=\"auto|\"]'))");
      await client.evaluate("{const select=document.querySelector('.model-native-select');select.value=Array.from(select.options).find(option=>option.value.startsWith('codex|')).value;select.dispatchEvent(new Event('change',{bubbles:true}));}void 0");
      await client.until("document.querySelector('.model-native-select')?.value.startsWith('codex|')");
      await client.evaluate("{const prompt=document.querySelector('.composer-body textarea');prompt.value='Черновик доступа';prompt.dispatchEvent(new Event('input',{bubbles:true}));const select=document.querySelector('.model-native-select');select.value=Array.from(select.options).find(option=>option.value.startsWith('auto|')).value;select.dispatchEvent(new Event('change',{bubbles:true}));}void 0");
      await client.until("document.querySelector('.model-native-select')?.value.startsWith('auto|')");
      assert.equal(await client.evaluate("document.querySelector('.composer-body textarea').value"), 'Черновик доступа');
      async function checkUserModelDetails() {
        const priceBefore = await client.evaluate("document.querySelector('.generate-button').textContent");
        await client.evaluate("document.querySelector('.model-picker-trigger').click();void 0");
        await client.until("document.querySelectorAll('.model-catalog-row').length > 0");
        assert.equal(await client.evaluate("document.querySelector('.model-catalog-price')"), null, 'model row prices are admin-only');
        assert.equal(await client.evaluate("document.querySelector('.model-catalog-variants')"), null, 'technical catalog variants are admin-only');
        assert.equal(await client.evaluate("Array.from(document.querySelectorAll('.model-catalog-copy small, .model-catalog-copy .model-catalog-provider, .model-brand-list strong')).some(node=>/\\b(?:APIMart|Kie(?:\\.ai)?|RouterAI|Codex)\\b|\\$/.test(node.textContent))"), false);
        assert.equal(await client.evaluate("Array.from(document.querySelectorAll('.model-catalog-copy small')).every(node=>node.textContent.trim().length > 0)"), true, 'users retain useful descriptions');
        assert.equal(await client.evaluate("document.querySelector('.generate-button').textContent"), priceBefore, 'opening the list does not change the generate-button price');
        await client.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));void 0");
      }
      await checkUserModelDetails();
      await sleep(800);
      const adminId = randomUUID(), adminToken = randomBytes(32).toString('base64url');
      await pool.query("INSERT INTO media_accounts(id,display_name,role) VALUES($1,'Access admin','admin')", [adminId]);
      await pool.query('INSERT INTO media_wallets(account_id,balance) VALUES($1,0)', [adminId]);
      await pool.query("INSERT INTO media_sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [hash(adminToken), adminId]);
      await client.command('Network.setCookie', { name: 'media-session', value: adminToken, url: origin, httpOnly: true, sameSite: 'Lax' });
      await client.command('Page.navigate', { url: origin + '/admin.html' });
      await client.until(`Boolean(document.querySelector('[data-model-access-account="${accountId}"]'))`);
      await client.evaluate(`document.querySelector('[data-model-access-account="${accountId}"]').click();document.querySelector('#modelAccessValue').value='gpt-only';document.querySelector('#modelAccessReason').value='Проверка прав из админки';document.querySelector('#modelAccessForm').requestSubmit();void 0`);
      await client.until("!document.querySelector('#modelAccessDialog').open && /сохранён|saved/.test(document.querySelector('#adminStatus').textContent)");
      const policy = (await fetch(origin + '/api/admin/accounts', { headers: { Cookie: `media-session=${adminToken}` } }).then(r => r.json())).result.find(row => row.id === accountId);
      assert.equal(policy.modelPermissions.modelAccess, 'gpt-only');
      assert.equal((await pool.query("SELECT data FROM media_records WHERE account_id=$1 AND namespace='model-access-audit'", [accountId])).rows[0].data.reason, 'Проверка прав из админки');
      await client.command('Network.setCookie', { name: 'media-session', value: token, url: origin, httpOnly: true, sameSite: 'Lax' });
      await client.command('Page.navigate', { url: origin + '/app' });
      await client.until("document.querySelector('.model-native-select')?.value.startsWith('codex|') && document.querySelectorAll('.composer-tabs button').length===2");
      assert.equal(await client.evaluate("document.querySelector('.sidebar-provider-menu')"), null);
      assert.equal(await client.evaluate("Array.from(document.querySelectorAll('.model-native-select option')).every(option=>option.value.startsWith('codex|'))"), true);
      assert.equal(await client.evaluate("document.querySelector('.composer-body textarea').value"), 'Черновик доступа');
      const denied = await client.evaluate(`(async()=>{const response=await fetch('/api/admin/model-access',{method:'POST',headers:{'X-Media-Client':'web','X-Media-User':'${accountId}','Content-Type':'application/json'},body:JSON.stringify({accountId:'${accountId}',policy:'all',reason:'self grant'})});return response.status;})()`);
      assert.equal(denied, 403);
      await runtime.accounts.setModelAccess(adminId, accountId, 'all', 'Восстановление доступа');
      await client.until("Boolean(document.querySelector('.model-native-select option[value^=\"auto|\"]')) && document.querySelectorAll('.composer-tabs button').length===4");
      await runtime.accounts.setModelAccess(adminId, accountId, 'gpt-only', 'Ограничение в открытой студии');
      await client.until("Array.from(document.querySelectorAll('.model-native-select option')).every(option=>option.value.startsWith('codex|')) && document.querySelectorAll('.composer-tabs button').length===2");
      await runtime.accounts.setModelAccess(adminId, accountId, 'all', 'Восстановление тестового доступа');
      await client.until("Boolean(document.querySelector('.model-native-select option[value^=\"auto|\"]')) && document.querySelectorAll('.composer-tabs button').length===4");
      await client.command('Network.setCookie', { name: 'media-session', value: adminToken, url: origin, httpOnly: true, sameSite: 'Lax' });
      await client.command('Page.navigate', { url: origin + '/app?interface=user' });
      await client.until("Boolean(document.querySelector('.model-picker-trigger:not(:disabled)'))");
      assert.equal(await client.evaluate("document.querySelector('.sidebar-provider-menu')"), null, 'admin user preview also hides the block');
      await checkUserModelDetails();
      await client.evaluate("document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('studio').toggleInterface();void 0");
      await client.until("Boolean(document.querySelector('.sidebar-provider-menu'))");
      await client.evaluate("document.querySelector('.sidebar-provider-option[data-provider=auto]').click();document.querySelector('.model-picker-trigger').click();void 0");
      await client.until("document.querySelectorAll('.model-catalog-price').length > 0 && document.querySelector('.model-catalog-variants')");
      assert.equal(await client.evaluate("/Kie|APIMart/.test(document.querySelector('.model-catalog-price').textContent)"), true, 'admin retains published provider prices');
      console.log('PASS: user model picker, hidden provider names and prices, preserved admin tariffs, generate-button price, admin access form, UTF-8 audit, restrictions, API self-grant rejection, restored access and admin user preview.');
      return;
    }
    if (process.env.BROWSER_E2E_FAVORITES_ONLY === '1') {
      assert.equal(await client.evaluate("Boolean(document.querySelector('.preset-bar'))"), false);
      await client.evaluate("document.querySelector('.model-picker-trigger').click();void 0");
      await client.until("Boolean(document.querySelector('.model-favorite-toggle:not(:disabled)'))");
      const before = await client.evaluate("document.querySelector('.model-native-select').value");
      const label = await client.evaluate("document.querySelector('.model-catalog-row .model-catalog-copy strong').textContent");
      await client.evaluate("document.querySelector('.model-favorite-toggle').click();void 0");
      await client.until("Boolean(document.querySelector('.model-favorite-toggle.active:not(:disabled)'))");
      assert.equal(await client.evaluate("document.querySelector('.model-native-select').value"), before);
      assert.equal(await client.evaluate("Boolean(document.querySelector('.model-catalog-popover'))"), true);
      await client.evaluate("document.querySelector('.model-favorites-icon').closest('button').click();void 0");
      await client.until("document.querySelectorAll('.model-catalog-row').length===1");
      assert.equal(await client.evaluate("document.querySelector('.model-catalog-copy strong').textContent"), label);
      await client.evaluate("{const search=document.querySelector('.model-catalog-search input');search.value='no-such-model-12345';search.dispatchEvent(new Event('input',{bubbles:true}));}void 0");
      await client.until("document.querySelectorAll('.model-catalog-row').length===0");
      await client.command('Page.reload');
      await client.until("Boolean(document.querySelector('.model-picker-trigger:not(:disabled)'))");
      await client.evaluate("document.querySelector('.model-picker-trigger').click();void 0");
      await client.until("Boolean(document.querySelector('.model-favorite-toggle.active:not(:disabled)'))");
      assert.equal(await client.evaluate("document.querySelector('.model-catalog-copy strong').textContent"), label);
      assert.equal(await client.evaluate("document.querySelectorAll('.model-catalog-row').length"), 1);
      await client.evaluate("document.querySelector('.model-favorite-toggle').click();void 0");
      await client.until("document.querySelectorAll('.model-catalog-row').length===0 && Boolean(document.querySelector('.model-catalog-empty'))");
      assert.deepEqual(await client.evaluate("fetch('/api/rpc/getModelFavorites',{method:'POST',headers:{'X-Media-Client':'web','X-Media-User':document.querySelector('meta[name=account-id]').content,'Content-Type':'application/json'},body:'[]'}).then(r=>r.json()).then(r=>r.result)"), []);
      console.log('Favorites browser E2E passed: star, scoped list, search, persistence, remove, no model change');
      return;
    }
    if (process.env.BROWSER_E2E_POPUPS_ONLY === '1') {
      await client.evaluate("window.prompt=window.confirm=window.alert=()=>{throw new Error('Native dialog called')};window.__popupStudio=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('studio');void 0");
      const openAdd = async () => {
        await client.evaluate("{const button=document.querySelector('.sidebar-toolbar .icon-button');button.focus();button.click();}void 0");
        await client.until("Boolean(document.querySelector('.popup-dialog[open] input'))");
      };
      const setName = async name => client.evaluate(`{const input=document.querySelector('.popup-field input');input.value=${JSON.stringify(name)};input.dispatchEvent(new Event('input',{bubbles:true}));}void 0`);
      const submit = async () => {
        await client.evaluate("document.querySelector('.popup-submit').click();void 0");
        await client.until("!document.querySelector('.popup-dialog[open]')");
      };
      const chatAction = async index => {
        await client.evaluate("Array.from(document.querySelectorAll('.sidebar-entry')).find(entry=>entry.querySelector('strong')?.textContent==='Окно: чат').querySelector('.entry-menu').click();void 0");
        await client.evaluate(`document.querySelectorAll('.entry-actions button')[${index}].click();void 0`);
        await client.until("Boolean(document.querySelector('.popup-dialog[open]'))");
      };
      const initialChats = await client.evaluate('window.__popupStudio.chats.length');
      await openAdd();
      assert.equal(await client.evaluate("document.activeElement===document.querySelector('.popup-field input') && document.activeElement.selectionEnd===document.activeElement.value.length"), true);
      await setName('   ');
      assert.equal(await client.evaluate("document.querySelector('.popup-submit').disabled"), true);
      await client.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await client.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await client.until("!document.querySelector('.popup-dialog[open]')");
      assert.equal(await client.evaluate('window.__popupStudio.chats.length'), initialChats);
      assert.equal(await client.evaluate("document.activeElement===document.querySelector('.sidebar-toolbar .icon-button')"), true);
      await openAdd();
      await client.command('Input.dispatchMouseEvent', { type: 'mousePressed', x: 2, y: 2, button: 'left', clickCount: 1 });
      await client.command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 2, y: 2, button: 'left', clickCount: 1 });
      await client.until("!document.querySelector('.popup-dialog[open]')");
      assert.equal(await client.evaluate('window.__popupStudio.chats.length'), initialChats);
      await openAdd();
      await setName('Окно: чат');
      // One transport failure proves that input survives and retry uses the real API.
      await client.evaluate("window.__popupFetch=window.fetch;window.fetch=(input,init)=>{if(init?.method==='POST' && new URL(String(input),location.origin).pathname==='/api/chats'){window.fetch=window.__popupFetch;return Promise.reject(new Error('Popup retry test'))}return window.__popupFetch(input,init)};document.querySelector('.popup-submit').click();void 0");
      await client.until("Boolean(document.querySelector('.popup-error'))");
      assert.equal(await client.evaluate("document.querySelector('.popup-field input').value"), 'Окно: чат');
      assert.equal(await client.evaluate("document.querySelector('.popup-submit').disabled"), false);
      await client.evaluate("document.querySelector('.popup-field input').focus();void 0");
      await client.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 });
      await client.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await client.until("!document.querySelector('.popup-dialog[open]') && window.__popupStudio.chats.some(chat=>chat.name==='Окно: чат')");
      const chatId = await client.evaluate("window.__popupStudio.chats.find(chat=>chat.name==='Окно: чат').id");
      assert.equal((await pool.query('SELECT name FROM media_chats WHERE id=$1', [chatId])).rows[0].name, 'Окно: чат');
      await chatAction(0);
      assert.equal(await client.evaluate("document.querySelector('.popup-field input').value"), 'Окно: чат');
      await setName('Не сохранять');
      await client.evaluate("document.querySelector('.popup-cancel').click();void 0");
      await client.until("!document.querySelector('.popup-dialog[open]')");
      assert.equal(await client.evaluate(`window.__popupStudio.chats.find(chat=>chat.id===${JSON.stringify(chatId)}).name`), 'Окно: чат');
      const projects = await client.evaluate("Promise.all([window.__popupStudio.createProject('Одинаковый'),window.__popupStudio.createProject('Одинаковый')]).then(projects=>projects.map(project=>project.id))");
      await chatAction(1);
      assert.deepEqual(await client.evaluate("Array.from(document.querySelectorAll('.popup-field option')).filter(option=>option.textContent==='Одинаковый').map(option=>option.value).sort()"), [...projects].sort());
      await client.evaluate(`{const select=document.querySelector('.popup-field select');select.value=${JSON.stringify(projects[1])};select.dispatchEvent(new Event('change',{bubbles:true}));}void 0`);
      await submit();
      assert.equal((await pool.query('SELECT project_id FROM media_chats WHERE id=$1', [chatId])).rows[0].project_id, projects[1]);
      // Return to standalone so archive exercises the same visible consumer.
      await client.evaluate(`window.__popupStudio.moveChat(${JSON.stringify(chatId)},null)`);
      await chatAction(2);
      assert.equal(await client.evaluate("document.activeElement===document.querySelector('.popup-cancel')"), true);
      await submit();
      assert.ok((await pool.query('SELECT archived_at FROM media_chats WHERE id=$1', [chatId])).rows[0].archived_at);
      await client.evaluate("document.querySelectorAll('.sidebar-tabs button')[2].click();void 0");
      await client.until("Boolean(document.querySelector('.archive-delete'))");
      await client.evaluate("document.querySelector('.archive-delete').click();void 0");
      await client.until("Boolean(document.querySelector('.popup-dialog[open].popup-danger'))");
      assert.equal(await client.evaluate("document.activeElement===document.querySelector('.popup-cancel')"), true);
      await client.evaluate("document.querySelector('.popup-cancel').click();void 0");
      await client.until("!document.querySelector('.popup-dialog[open]')");
      assert.equal((await pool.query('SELECT name FROM media_chats WHERE id=$1', [chatId])).rowCount, 1);
      console.log('Popup browser E2E passed: native dialogs forbidden, cancel/Escape/backdrop, focus, retry/Enter, real chat creation, project IDs and archive/delete confirmation');
      return;
    }
    if (process.env.BROWSER_E2E_OMNIHUMAN_ONLY === '1') {
      await client.evaluate("document.querySelectorAll('.composer-tabs button')[2].click();void 0");
      await client.evaluate("document.querySelector('.sidebar-provider-menu').open=true;document.querySelector('.sidebar-provider-option[data-provider=media]').click();void 0");
      await client.until("document.querySelector('.model-native-select option[value=\"kie:omnihuman-1-5\"]') !== null");
      await client.evaluate("{const select=document.querySelector('.model-native-select');select.value='kie:omnihuman-1-5';select.dispatchEvent(new Event('change',{bubbles:true}));}void 0");
      await client.until("document.querySelectorAll('.source-strip input[type=file]').length===3 && document.querySelector('.video-settings-bar')");
      await client.evaluate("document.querySelector('.video-settings-toggle').click();void 0");
      await client.until("document.querySelector('.video-advanced-panel input[type=number]') !== null");
      // Administrators retain every control; their user-preview uses the user policy.
      assert.equal(await client.evaluate("document.querySelectorAll('.video-advanced-panel input[type=checkbox]').length"), 1);
      assert.equal(await client.evaluate("/скрыт для пользователя|hidden for users/.test(document.querySelector('.video-advanced-panel').textContent)"), true);
      await client.evaluate("document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('studio').toggleInterface();void 0");
      assert.equal(await client.evaluate("document.querySelectorAll('.video-advanced-panel input[type=checkbox]').length"), 0);
      assert.equal(await client.evaluate("document.querySelector('.video-advanced-panel input[type=number]').value"), '-1');
      assert.equal(await client.evaluate("document.querySelector('.composer-body textarea') !== null"), true);
      assert.deepEqual(await client.evaluate("Array.from(document.querySelectorAll('.video-settings-bar select option')).map(option=>option.value).filter(value=>['720','1080'].includes(value))"), ['720', '1080']);
      assert.equal(await client.evaluate("document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('studio').mediaInput.pe_fast_mode"), false);
      await client.until("document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('studio').accountReady");
      await client.evaluate("document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('studio').mediaInput.pe_fast_mode=true;void 0");
      await sleep(1500);
      await client.command('Page.reload');
      await client.until("document.querySelector('.model-native-select')?.value==='kie:omnihuman-1-5'");
      await client.evaluate("document.querySelector('.video-settings-toggle').click();void 0");
      await client.until("document.querySelector('.video-advanced-panel input[type=number]') !== null");
      assert.equal(await client.evaluate("document.querySelectorAll('.video-advanced-panel input[type=checkbox]').length"), 0);
      assert.equal(await client.evaluate("document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('studio').mediaInput.pe_fast_mode"), true);
      // Exercise APIMart metadata through the same real composer; no paid requests.
      const apimartFixture = require('../src/providers/apimart/catalog').describeModel({ id: 'kling-v2-6-motion-control', category: 'video' });
      await client.evaluate(`{const store=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('studio');store.toggleInterface();store.serviceModelConfig=null;store.apimartCatalog={models:[${JSON.stringify(apimartFixture)}]};store.setProvider('apimart');store.setSelectedModel('kling-v2-6-motion-control');}void 0`);
      await client.until("document.querySelectorAll('.source-strip input[type=file]').length===1 && document.querySelector('.video-settings-toggle')");
      assert.deepEqual(await client.evaluate("Array.from(document.querySelectorAll('.video-setting:not(.video-model-setting) select option')).map(option=>option.textContent)"), ['720p', '1080p']);
      await client.evaluate("{const store=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('studio');store.mediaInput.mode='720p';store.setSelectedModel('kling-v2-6-motion-control');}void 0");
      await client.until("document.querySelector('.video-setting:not(.video-model-setting) select')?.value==='std'");
      assert.equal(await client.evaluate("document.querySelector('.video-settings-bar .field-error') === null"), true);
      await client.evaluate("if(document.querySelector('.video-settings-toggle').getAttribute('aria-expanded')!=='true')document.querySelector('.video-settings-toggle').click();void 0");
      await client.until("document.querySelector('.video-advanced-panel input[type=text]') !== null");
      assert.equal(await client.evaluate("/hidden for users|скрыт для пользователя/.test(document.querySelector('.video-advanced-panel').textContent)"), true);
      await client.evaluate("document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('studio').toggleInterface();void 0");
      await client.until("document.querySelectorAll('.source-strip input[type=file]').length===1");
      assert.equal(await client.evaluate("document.querySelector('.video-advanced-panel input[type=text]') !== null"), true);
      assert.equal(await client.evaluate("!/hidden for users|скрыт для пользователя/.test(document.querySelector('.video-advanced-panel').textContent)"), true);
      assert.equal(await client.evaluate("document.querySelector('.form-error') !== null && !document.querySelector('.form-error[role=alert]') && document.querySelector('.generate-button').disabled"), true);
      await client.evaluate("document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('studio').mediaInput.video_url='https://example.test/saved.mp4';void 0");
      await client.until("!document.querySelector('.form-error[role=alert]')");
      assert.equal(await client.evaluate("document.querySelectorAll('.source-strip input[type=file]').length"), 1);
      await client.evaluate("document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('studio').toggleInterface();void 0");
      await client.until("document.querySelector('.video-advanced-panel input[type=text]')?.value==='https://example.test/saved.mp4'");
      assert.equal(await client.evaluate("document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('studio').mediaInput.video_url"), 'https://example.test/saved.mp4');
      await client.evaluate("{const store=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('studio');store.setMode('audio');store.setProvider('media');store.serviceModelConfig=null;store.setSelectedModel('kie:ai-music-api/replace-section');store.toggleInterface();}void 0");
      await client.until("document.querySelector('.model-native-select')?.value==='kie:ai-music-api/replace-section' && document.querySelectorAll('.select-pill select').length > 0");
      // The required common Suno controls must remain present in both input modes.
      await client.until("document.querySelectorAll('.advanced-grid input[type=number]').length >= 2 && document.querySelectorAll('.advanced-grid input[type=text]').length >= 3");
      await client.evaluate("{const select=Array.from(document.querySelectorAll('.select-pill select')).find(select=>Array.from(select.options).some(option=>option.textContent.includes('uploaded custom audio')));select.value='1';select.dispatchEvent(new Event('change',{bubbles:true}));}void 0");
      await client.until("document.querySelectorAll('.advanced-grid input[type=number]').length >= 2");
      assert.equal(await client.evaluate("document.querySelector('.composer-body textarea') !== null"), true);
      await client.evaluate("document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('studio').setSelectedModel('kie:ai-music-api/separate-vocals');void 0");
      await client.until("document.querySelector('.model-native-select')?.value==='kie:ai-music-api/separate-vocals' && document.querySelector('.task-reference-field input')");
      for (const admin of [false, true]) {
        await client.evaluate(`{const store=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('studio');if(store.isAdmin!==${admin})store.toggleInterface();store.mediaInput={task_id:'example-task',audio_id:'example-track',type:'separate_vocal'};}void 0`);
        await client.until("!document.querySelector('.composer-body .form-error')");
        assert.equal(await client.evaluate("Array.from(document.querySelectorAll('.advanced-grid input[type=text]')).some(input=>input.value==='example-track')"), true);
        assert.equal(await client.evaluate("/hidden for users|скрыт для пользователя/.test(document.querySelector('.advanced-grid').textContent)"), false);
        await client.evaluate("document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('studio').mediaInput.type='split_stem_advanced';void 0");
        await client.until("document.querySelector('.composer-body .form-error') && document.querySelector('.generate-button').disabled");
        assert.equal(await client.evaluate("Array.from(document.querySelectorAll('.advanced-grid select')).find(select=>Array.from(select.options).some(option=>option.value==='Lead Vocal'))?.closest('label').querySelector('span').textContent.includes('*')"), true);
        await client.evaluate("document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('studio').mediaInput.stem_name='Lead Vocal';void 0");
        await client.until("!document.querySelector('.composer-body .form-error')");
        await client.evaluate("{const select=Array.from(document.querySelectorAll('.select-pill select')).find(select=>Array.from(select.options).some(option=>option.textContent.includes('user-uploaded audio')));select.value='1';select.dispatchEvent(new Event('change',{bubbles:true}));}void 0");
        await client.evaluate("document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('studio').mediaInput={audio_url:'https://example.test/audio.mp3',type:'split_stem'};void 0");
        await client.until("!document.querySelector('.task-reference-field') && !document.querySelector('.composer-body .form-error')");
        assert.equal(await client.evaluate("document.querySelectorAll('.advanced-grid input[type=text]').length"), 0);
        // Return to the existing-track branch for the next role's check.
        await client.evaluate("{const select=Array.from(document.querySelectorAll('.select-pill select')).find(select=>Array.from(select.options).some(option=>option.textContent.includes('user-uploaded audio')));select.value='0';select.dispatchEvent(new Event('change',{bubbles:true}));}void 0");
      }
      console.log('Kie/APIMart UI passed: required fields restored, optional fields hidden, Suno common/mode fields and saved drafts preserved; no provider generation');
      return;
    }
    if (process.env.BROWSER_E2E_MOVIE_ONLY === '1' || process.env.BROWSER_E2E_MOVIE_GRID_ONLY === '1' || process.env.BROWSER_E2E_MOVIE_EDIT_ONLY === '1') {
      await client.evaluate("document.querySelector('.sidebar-movie-link').click();void 0");
      await client.until("document.querySelector('.movie-editor .movie-title-add') && !document.querySelector('.movie-controls').disabled");
      await client.evaluate("document.querySelector('.movie-title-add').click();void 0");
      await client.until("document.querySelector('.movie-scene') && !document.querySelector('.movie-render').disabled");
      // Selection follows scene identity through edits, reordering and deletion.
      await client.evaluate("{const el=document.querySelector('.movie-scene textarea');el.value='Grid first';el.dispatchEvent(new Event('input',{bubbles:true}));}void 0");
      await client.evaluate("document.querySelector('.movie-title-add').click();void 0");
      await client.until("document.querySelectorAll('.movie-material').length===2 && document.querySelector('.movie-material:last-child').getAttribute('aria-pressed')==='true'");
      await client.evaluate("{const el=document.querySelector('.movie-scene textarea');el.value='Grid second';el.dispatchEvent(new Event('input',{bubbles:true}));}void 0");
      await client.evaluate("document.querySelector('.movie-material:first-child').click();void 0");
      await client.until("document.querySelector('.movie-scene textarea').value==='Grid first'");
      assert.equal(await client.evaluate("document.querySelectorAll('.movie-scene textarea').length"), 1);
      await client.evaluate("document.querySelectorAll('.movie-details .movie-scene-actions button')[1].click();void 0");
      await client.until("document.querySelector('.movie-material:last-child').getAttribute('aria-pressed')==='true' && document.querySelector('.movie-scene textarea').value==='Grid first'");
      await client.evaluate("document.querySelectorAll('.movie-details .movie-scene-actions button')[2].click();void 0");
      await client.until("document.querySelectorAll('.movie-material').length===1 && document.querySelector('.movie-scene textarea').value==='Grid second'");
      // Long library filenames must not widen the grid; scene actions remain reachable.
      await client.evaluate("{const option=document.createElement('option');option.textContent='GPT Image 1 Mini · '+ 'long-filename-'.repeat(20)+'.png';document.querySelectorAll('.movie-controls select')[1].append(option);}void 0");
      for (const width of [390, 1024, 1440]) {
        await client.command('Emulation.setDeviceMetricsOverride', { width, height: 768, deviceScaleFactor: 1, mobile: false });
        await sleep(100);
        const layout = await client.evaluate("(()=>{const editor=document.querySelector('.movie-editor');const preview=document.querySelector('.movie-output');const actions=document.querySelector('.movie-scene-actions');editor.scrollTop=editor.scrollHeight;const e=editor.getBoundingClientRect(),p=preview.getBoundingClientRect(),a=actions.getBoundingClientRect();return {width:editor.clientWidth,scrollWidth:editor.scrollWidth,bottom:e.bottom,actionsBottom:a.bottom,previewLeft:p.left,previewRight:p.right,left:e.left,right:e.right,height:innerHeight};})()");
        assert.ok(layout.scrollWidth <= layout.width + 1, `Movie overflows horizontally at ${width}: ${JSON.stringify(layout)}`);
        assert.ok(layout.previewLeft >= layout.left - 1 && layout.previewRight <= layout.right + 1, `Preview exceeds editor at ${width}`);
        assert.ok(layout.actionsBottom <= layout.bottom + 1 && layout.bottom <= layout.height + 1, `Scene actions cannot be reached at ${width}: ${JSON.stringify(layout)}`);
      }
      await client.command('Emulation.clearDeviceMetricsOverride');
      if (process.env.BROWSER_E2E_MOVIE_EDIT_ONLY === '1') {
        // A real changing video lets the exported pixel prove that trimStart
        // is applied, including after split and the native decoder recovery.
        await client.evaluate(`(async()=>{
          const c=document.createElement('canvas');c.width=160;c.height=90;const ctx=c.getContext('2d');
          ctx.fillStyle='red';ctx.fillRect(0,0,160,90);
          const photo=await new Promise(resolve=>c.toBlob(resolve,'image/png'));
          const stream=c.captureStream(30);const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'});
          const chunks=[];recorder.ondataavailable=e=>chunks.push(e.data);const stopped=new Promise(resolve=>recorder.onstop=resolve);
          recorder.start();const started=performance.now();const paint=setInterval(()=>{ctx.fillStyle=performance.now()-started<1000?'red':'lime';ctx.fillRect(0,0,160,90);},30);
          await new Promise(resolve=>setTimeout(resolve,3100));clearInterval(paint);recorder.stop();await stopped;stream.getTracks().forEach(t=>t.stop());
          const files=new DataTransfer();files.items.add(new File([photo],'framing.png',{type:'image/png'}));files.items.add(new File(chunks,'trim.webm',{type:'video/webm'}));
          const input=document.querySelector('.movie-file input');input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}));
        })()`);
        await client.until("document.querySelectorAll('.movie-material').length===3 && !document.querySelector('.movie-controls').disabled");
        await client.evaluate(`{
          const buffer=new ArrayBuffer(44+48000*3*2),view=new DataView(buffer);
          const text=(at,s)=>{for(let i=0;i<s.length;i++)view.setUint8(at+i,s.charCodeAt(i));};
          text(0,'RIFF');view.setUint32(4,buffer.byteLength-8,true);text(8,'WAVEfmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,48000,true);view.setUint32(28,96000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,buffer.byteLength-44,true);
          for(let i=0;i<48000*3;i++)view.setInt16(44+i*2,Math.sin(i*440*2*Math.PI/48000)*9000,true);
          const data=new DataTransfer();data.items.add(new File([buffer],'sound.wav',{type:'audio/wav'}));const input=document.querySelector('input[accept="audio/*"]');input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));
        }void 0`);
        await client.until("document.querySelector('.movie-music-volume') && !document.querySelector('.movie-controls').disabled");
        await client.evaluate("{const el=document.querySelector('.movie-music-volume');el.value='0.25';el.dispatchEvent(new Event('input',{bubbles:true}));const fields=document.querySelectorAll('.movie-music-settings input[type=number]');for(const [index,val] of [[0,'1'],[1,'0.2'],[2,'0.3'],[3,'0.4']]){fields[index].value=val;fields[index].dispatchEvent(new Event('input',{bubbles:true}));}}void 0");
        await client.evaluate(`{
          function set(selector,value,event='change'){const el=document.querySelector(selector);el.value=value;el.dispatchEvent(new Event(event,{bubbles:true}));}
          set('.movie-trim-end','2.5');set('.movie-trim-start','1.5');
          document.querySelector('.movie-seek-scene').click();
        }void 0`);
        await client.until("Number(document.querySelector('.movie-duration').value)===1");
        await client.evaluate("{const el=document.querySelector('.movie-playhead');el.value='255';el.dispatchEvent(new Event('input',{bubbles:true}));}void 0");
        // Title=3s and image=5s, so frame 255 is 0.5s into trimmed video.
        await client.until("!document.querySelector('.movie-split').disabled");
        await client.evaluate("document.querySelector('.movie-split').click();void 0");
        await client.until("document.querySelectorAll('.movie-material').length===4 && Number(document.querySelector('.movie-trim-start').value)===2");
        await client.evaluate(`{
          document.querySelectorAll('.movie-material')[1].click();
        }void 0`);
        await client.evaluate(`{
          function set(selector,value,event='change'){const el=document.querySelector(selector);el.value=value;el.dispatchEvent(new Event(event,{bubbles:true}));}
          set('.movie-fit','cover');set('.movie-scale','1.3','input');set('.movie-offset-x','10','input');set('.movie-motion','zoom-in');
          const text=document.querySelector('.movie-scene textarea');text.value='Монтаж';text.dispatchEvent(new Event('input',{bubbles:true}));
        }void 0`);
        await client.until("document.querySelector('.movie-caption-start')");
        await client.evaluate(`{
          function set(selector,value,event='change'){const el=document.querySelector(selector);el.value=value;el.dispatchEvent(new Event(event,{bubbles:true}));}
          set('.movie-caption-start','0.3');set('.movie-caption-end','1.2');set('.movie-transition','slide');
        }void 0`);
        await client.until("document.querySelector('.movie-transition-seconds')");
        await client.evaluate("{const el=document.querySelector('.movie-transition-seconds');el.value='0.2';el.dispatchEvent(new Event('change',{bubbles:true}));}void 0");
        await client.until("/сохранён|saved/.test(document.querySelector('.movie-draft-status').textContent)");
        const edited = await client.evaluate("(async()=>{const r=await fetch('/api/movie/draft',{headers:{'X-Media-Client':'web'}});return (await r.json()).result;})()");
        assert.deepEqual(edited.scenes.slice(2).map(s=>[s.trimStart,s.seconds]), [[1.5,0.5],[2,0.5]]);
        assert.deepEqual([edited.scenes[1].fit,edited.scenes[1].scale,edited.scenes[1].motion,edited.scenes[1].captionStart,edited.scenes[1].captionEnd], ['cover',1.3,'zoom-in',0.3,1.2]);
        assert.equal(edited.scenes[1].title, 'Монтаж');
        assert.deepEqual([edited.musicSettings.volume,edited.musicSettings.start,edited.musicSettings.trimStart], [0.25,1,0.2]);
        assert.equal(await client.evaluate("document.querySelectorAll('.timeline-track').length"), 4);
        await client.command('Page.reload', { ignoreCache: true });
        await sleep(500);
        await client.until("document.querySelectorAll('.movie-material').length===4 && !document.querySelector('.movie-render').disabled");
        await client.evaluate("document.querySelectorAll('.movie-material')[3].click();void 0");
        await client.until("Number(document.querySelector('.movie-trim-start').value)===2");
        // Frame 8.4 seconds is within the last half of the trimmed source.
        await client.evaluate("{const decode=VideoDecoder.prototype.decode;VideoDecoder.prototype.decode=function(packet){VideoDecoder.prototype.decode=decode;window.__editRecovery=true;throw new Error('Cannot decode video frame');};document.querySelector('.movie-render').click();}void 0");
        for(let attempt=0;attempt<1200;attempt++) { if(await client.evaluate("Boolean(document.querySelector('.movie-download,.movie-editor .form-error'))"))break;await sleep(100); }
        assert.equal(await client.evaluate("document.querySelector('.movie-editor .form-error')?.textContent || ''"), '');
        await client.until("document.querySelector('.movie-download')");
        const pixels = await client.evaluate(`(async()=>{
          const v=document.createElement('video');v.src=document.querySelector('.movie-download').href;
          await new Promise((resolve,reject)=>{v.onloadeddata=resolve;v.onerror=reject;});
          const sought=new Promise(resolve=>v.onseeked=resolve);v.currentTime=8.4;await sought;
          const c=document.createElement('canvas');c.width=v.videoWidth;c.height=v.videoHeight;const ctx=c.getContext('2d');ctx.drawImage(v,0,0);
          const blob=await(await fetch(v.src)).blob();const context=new AudioContext();const audio=await context.decodeAudioData(await blob.arrayBuffer());const samples=audio.getChannelData(0);const energy=(start,end)=>{let total=0,count=0;for(let i=Math.round(start*audio.sampleRate);i<Math.min(samples.length,Math.round(end*audio.sampleRate));i++){total+=samples[i]*samples[i];count++;}return Math.sqrt(total/Math.max(1,count));};const silent=energy(0.1,0.5),audible=energy(1.6,2),faded=energy(3.65,3.8);await context.close();
          return {duration:v.duration,pixel:Array.from(ctx.getImageData(c.width/2,c.height/2,1,1).data),silent,audible,faded};
        })()`);
        assert.ok(Math.abs(pixels.duration-8.8)<0.1, `Edited duration ${pixels.duration}`);
        assert.ok(pixels.pixel[1]>180 && pixels.pixel[0]<60, `Trimmed recovery frame ${pixels.pixel}`);
        assert.ok(pixels.silent < 0.001 && pixels.audible > 0.01 && pixels.audible < 0.08 && pixels.faded < pixels.audible / 2, `Music delay/volume/fade ${JSON.stringify(pixels)}`);
        assert.equal(await client.evaluate('window.__editRecovery'), true);
        await saveMovieArtifact(client, '.movie-download', 'export-edited.mp4');
        console.log('Movie editing passed: trim/split, framing/motion, timed text, transition, timeline seek, persistent draft and exported source pixels with decoder recovery');
        return;
      }
      if (process.env.BROWSER_E2E_MOVIE_GRID_ONLY === '1') {
        // Exercise the shipped scoped CSS in both system motion modes. A
        // persistent probe avoids racing the completion of small thumbnails.
        await client.evaluate("{const root=document.querySelector('.movie-material-thumbnail');const probe=document.createElement('span');for(const attr of root.attributes)if(attr.name.startsWith('data-v-'))probe.setAttribute(attr.name,attr.value);probe.className='movie-thumbnail-spinner';probe.id='movie-spinner-probe';root.append(probe);}void 0");
        for (const motion of ['no-preference', 'reduce']) {
          await client.command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: motion }] });
          const rotates = await client.evaluate("(async()=>{const el=document.querySelector('#movie-spinner-probe');const first=getComputedStyle(el).transform;await new Promise(resolve=>setTimeout(resolve,200));return getComputedStyle(el).animationPlayState==='running' && getComputedStyle(el).transform!==first;})()");
          assert.equal(rotates, true, `Thumbnail spinner rotates with motion=${motion}`);
        }
        await client.command('Emulation.setEmulatedMedia', { features: [] });
        await client.evaluate("document.querySelector('#movie-spinner-probe').remove();void 0");
        await client.until("document.querySelector('.movie-draft-status').textContent.includes('сохранён') || document.querySelector('.movie-draft-status').textContent.includes('saved')");
        await client.command('Page.reload', { ignoreCache: true });
        await client.until("document.querySelector('.movie-scene textarea')?.value==='Grid second' && document.querySelector('.movie-material')?.getAttribute('aria-pressed')==='true'");
        // Real image and silent video thumbnails, without starting playback.
        await client.evaluate("(async()=>{const canvas=document.createElement('canvas');canvas.width=64;canvas.height=32;const ctx=canvas.getContext('2d');ctx.fillStyle='red';ctx.fillRect(0,0,64,32);const image=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));const stream=canvas.captureStream(10);const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'});const chunks=[];recorder.ondataavailable=event=>chunks.push(event.data);const stopped=new Promise(resolve=>recorder.onstop=resolve);recorder.start();const paint=setInterval(()=>{ctx.fillStyle='red';ctx.fillRect(0,0,64,32);},50);await new Promise(resolve=>setTimeout(resolve,1200));clearInterval(paint);recorder.stop();await stopped;stream.getTracks().forEach(track=>track.stop());const data=new DataTransfer();data.items.add(new File([image],'thumb.png',{type:'image/png'}));data.items.add(new File(chunks,'thumb.webm',{type:'video/webm'}));const input=document.querySelector('.movie-file input');input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()");
        await client.until("document.querySelectorAll('.movie-material').length===3 && !document.querySelector('.movie-controls').disabled");
        await client.evaluate("document.querySelector('.movie-material:last-child').scrollIntoView();void 0");
        await client.until("Array.from(document.querySelectorAll('.movie-material-thumbnail img')).filter(img=>img.complete && img.naturalWidth>0).length===2");
        assert.equal(await client.evaluate("document.querySelector('.movie-material:last-child .movie-material-thumbnail img').src.startsWith('data:image/jpeg')"), true);
        assert.equal(await client.evaluate("document.querySelector('.movie-material:last-child .movie-material-thumbnail img').naturalWidth<=320"), true);
        assert.equal(await client.evaluate("document.querySelectorAll('.movie-thumbnail-play').length"), 1);
        await client.evaluate("document.querySelectorAll('.movie-material-thumbnail img')[0].dispatchEvent(new Event('error'));void 0");
        await client.until("document.querySelectorAll('.movie-material')[1].querySelector('.movie-material-icon') && document.querySelectorAll('.movie-material-thumbnail img').length===1");
        console.log('Movie material grid passed: selection, edit, reorder, delete, responsive layout and draft restore');
        console.log('Movie thumbnails passed: photo, bounded video still and icon fallback');
        return;
      }
      await client.evaluate("document.querySelector('.movie-editor').scrollTop=0;void 0");
      await client.evaluate("{const el=document.querySelector('.movie-scene input[type=number]');el.value='1';el.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.movie-scene textarea').value='Remotion тест';document.querySelector('.movie-scene textarea').dispatchEvent(new Event('input',{bubbles:true}));}void 0");
      await client.evaluate("document.querySelector('.movie-render').click();void 0");
      for (let attempt = 0; attempt < 600; attempt++) {
        if (await client.evaluate("Boolean(document.querySelector('.movie-download, .movie-editor .form-error'))")) break;
        await sleep(100);
      }
      assert.equal(await client.evaluate("document.querySelector('.movie-editor .form-error')?.textContent || ''"), '');
      await client.until("document.querySelector('.movie-download')");
      const rendered = await client.evaluate("(async()=>{const url=document.querySelector('.movie-download').href;const blob=await(await fetch(url)).blob();window.__movieBlob=blob;const bytes=new Uint8Array(await blob.arrayBuffer());const video=document.createElement('video');video.src=url;await new Promise((resolve,reject)=>{video.onloadedmetadata=resolve;video.onerror=reject;});return {size:blob.size,header:String.fromCharCode(...bytes.slice(4,8)),width:video.videoWidth,height:video.videoHeight,duration:video.duration};})()");
      assert.equal(rendered.header, 'ftyp');
      assert.deepEqual([rendered.width, rendered.height], [720, 1280]);
      assert.ok(rendered.size > 1000);
      assert.ok(Math.abs(rendered.duration - 1) < 0.1);
      await saveMovieArtifact(client, '.movie-download', 'export-title.mp4');
      await client.evaluate("window.__nativeDisplayCapture=navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getDisplayMedia=async options=>{window.__lastPreviewCapture=await window.__nativeDisplayCapture(options);return window.__lastPreviewCapture;};document.querySelector('.movie-record-preview').click();void 0");
      await client.until("Boolean(document.querySelector('.movie-preview-download, .movie-editor .form-error')) && !document.querySelector('.movie-controls').disabled");
      assert.equal(await client.evaluate("document.querySelector('.movie-editor .form-error')?.textContent || ''"), '');
      const recorded = await client.evaluate("(async()=>{const a=document.querySelector('.movie-preview-download');const blob=await(await fetch(a.href)).blob();const v=document.createElement('video');v.src=a.href;await new Promise((resolve,reject)=>{v.onloadedmetadata=resolve;v.onerror=reject;});return {size:blob.size,type:blob.type,filename:a.download,width:v.videoWidth,height:v.videoHeight};})()");
      assert.ok(recorded.size > 1000);
      assert.ok(recorded.height > recorded.width, `Only the portrait composition is captured: ${JSON.stringify(recorded)}`);
      assert.ok(recorded.filename.endsWith(recorded.type.startsWith('video/mp4') ? '.mp4' : '.webm'));
      await saveMovieArtifact(client, '.movie-preview-download', recorded.type.startsWith('video/mp4') ? 'preview-title.mp4' : 'preview-title.webm');
      assert.equal(await client.evaluate("(async()=>{const v=document.createElement('video');v.src=document.querySelector('.movie-preview-download').href;await new Promise((resolve,reject)=>{v.onloadedmetadata=resolve;v.onerror=reject;});if(!Number.isFinite(v.duration)||v.duration<=0)throw new Error('Missing finalized duration');const t=v.duration*0.6;const seeked=new Promise((resolve,reject)=>{v.onseeked=resolve;v.onerror=reject;});v.currentTime=t;await seeked;return Math.abs(v.currentTime-t)<0.1;})()"), true);
      assert.equal(await client.evaluate("window.__lastPreviewCapture.getTracks().every(track=>track.readyState==='ended')"), true);
      await client.evaluate("{const el=document.querySelector('.movie-scene input[type=number]');el.value='5';el.dispatchEvent(new Event('input',{bubbles:true}));}void 0");
      await client.until("!document.querySelector('.movie-preview-download')");
      await client.evaluate("document.querySelector('.movie-record-preview').click();void 0");
      await client.until("document.querySelector('.is-recording') && document.querySelector('.movie-output progress')?.value>0");
      await client.evaluate("document.querySelector('.movie-output [role=status] button').click();void 0");
      await client.until("!document.querySelector('.is-recording') && !document.querySelector('.movie-controls').disabled");
      assert.equal(await client.evaluate("Boolean(document.querySelector('.movie-preview-download, .movie-editor .form-error'))"), false);
      assert.equal(await client.evaluate("window.__lastPreviewCapture.getTracks().every(track=>track.readyState==='ended')"), true);
      await client.evaluate("{const el=document.querySelector('.movie-scene input[type=number]');el.value='1';el.dispatchEvent(new Event('input',{bubbles:true}));}void 0");
      // Real locally uploaded image + previously rendered video and PCM audio.
      await client.evaluate("(async()=>{const canvas=document.createElement('canvas');canvas.width=32;canvas.height=32;const ctx=canvas.getContext('2d');ctx.fillStyle='red';ctx.fillRect(0,0,32,32);const image=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));const data=new DataTransfer();data.items.add(new File([image],'test.png',{type:'image/png'}));data.items.add(new File([window.__movieBlob],'test.mp4',{type:'video/mp4'}));const input=document.querySelector('.movie-file input');input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));const buffer=new ArrayBuffer(44+48000*2);const view=new DataView(buffer);function text(at,value){for(let i=0;i<value.length;i++)view.setUint8(at+i,value.charCodeAt(i));}text(0,'RIFF');view.setUint32(4,buffer.byteLength-8,true);text(8,'WAVEfmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,48000,true);view.setUint32(28,96000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,96000,true);for(let i=0;i<48000;i++)view.setInt16(44+i*2,Math.sin(i*440*2*Math.PI/48000)*5000,true);const audio=new DataTransfer();audio.items.add(new File([buffer],'music.wav',{type:'audio/wav'}));const audioInput=document.querySelector('input[accept=\"audio/*\"]');audioInput.files=audio.files;audioInput.dispatchEvent(new Event('change',{bubbles:true}));})()");
      await client.until("document.querySelectorAll('.movie-material').length===3");
      await client.until("!document.querySelector('.movie-controls').disabled");
      const fullClipSeconds = await client.evaluate("window.__movieFullSeconds=Number(document.querySelector('.movie-scene input[type=number]').value)");
      assert.ok(Math.abs(fullClipSeconds - rendered.duration) <= 1 / 30, 'Imported clip keeps its measured duration to the nearest frame');
      await client.evaluate("{const el=document.querySelector('.movie-scene input[type=number]');el.value='0.5';el.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.movie-full-clip').click();}void 0");
      await client.until("!document.querySelector('.movie-controls').disabled && Number(document.querySelector('.movie-scene input[type=number]').value)===window.__movieFullSeconds");
      // A failed source read must retain a safe, useful cause and allow retry.
      await client.evaluate("window.__renderFetch=window.fetch;window.fetch=(input,init)=>/\\/api\\/(content|sources)\\//.test(String(input))?Promise.reject(new TypeError('Failed to fetch private-source?token=secret')):window.__renderFetch(input,init);document.querySelector('.movie-render').click();void 0");
      await client.until("document.querySelector('.movie-editor .form-error')?.textContent.includes('media:NETWORK') && !document.querySelector('.movie-render').disabled");
      assert.equal(await client.evaluate("document.querySelector('.movie-editor .form-error').textContent.includes('secret')"), false);
      await client.evaluate("window.fetch=window.__renderFetch;void 0");
      // Slow full downloads are allowed; per-frame Range reads and duplicate
      // source requests are forbidden while exporting the prepared local files.
      await client.evaluate("window.__exportReads={};window.fetch=async(input,init)=>{if(document.querySelector('.movie-controls').disabled && /\\/api\\/(content|sources)\\//.test(String(input))){const key=String(input);window.__exportReads[key]=(window.__exportReads[key]||0)+1;if(window.__exportReads[key]>1 || new Headers(init?.headers).has('Range'))throw new Error('Renderer attempted another network source read');await new Promise(resolve=>setTimeout(resolve,2000));}return window.__renderFetch(input,init);};void 0");
      // Simulate a WebCodecs decoder failure after support probing. Recovery
      // must use native video frames, keep audio and reuse downloaded sources.
      await client.evaluate("{const decode=VideoDecoder.prototype.decode;VideoDecoder.prototype.decode=function(packet){VideoDecoder.prototype.decode=decode;window.__movieDecoderRecovery=true;throw new Error('Cannot decode video frame');};}void 0");
      await client.evaluate("(async()=>{for(const tile of document.querySelectorAll('.movie-material')){tile.click();await new Promise(resolve=>setTimeout(resolve,0));const el=document.querySelector('.movie-scene input[type=number]');el.value='1';el.dispatchEvent(new Event('input',{bubbles:true}));const transition=document.querySelector('.movie-transition');transition.value='fade';transition.dispatchEvent(new Event('change',{bubbles:true}));}document.querySelector('.movie-render').click();})()");
      await client.until("/Подготовка файлов|Preparing files/.test(document.querySelector('.movie-output [role=status]')?.textContent || '')");
      for (let attempt = 0; attempt < 600; attempt++) {
        if (await client.evaluate("Boolean(document.querySelector('.movie-download, .movie-editor .form-error'))")) break;
        await sleep(100);
      }
      assert.equal(await client.evaluate("document.querySelector('.movie-editor .form-error')?.textContent || ''"), '');
      await client.until("document.querySelector('.movie-download')");
      const finalVideo = await client.evaluate("(async()=>{const blob=await(await fetch(document.querySelector('.movie-download').href)).blob();const video=document.createElement('video');video.src=URL.createObjectURL(blob);await new Promise((resolve,reject)=>{video.onloadedmetadata=resolve;video.onerror=reject;});video.currentTime=0.99;await new Promise(resolve=>video.onseeked=resolve);const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;const ctx=canvas.getContext('2d');ctx.drawImage(video,0,0);const pixel=Array.from(ctx.getImageData(canvas.width/2,canvas.height/2,1,1).data);const context=new AudioContext();const audio=await context.decodeAudioData(await blob.arrayBuffer());const audible=audio.getChannelData(0).some(sample=>Math.abs(sample)>0.01);await context.close();return {duration:video.duration,size:blob.size,pixel,audible};})()");
      assert.equal(await client.evaluate('window.__movieDecoderRecovery'), true);
      const recoveredFrameDifference = await client.evaluate("(async()=>{async function pixels(src,time){const v=document.createElement('video');v.src=src;await new Promise((resolve,reject)=>{v.onloadeddata=resolve;v.onerror=reject;});const seeked=new Promise(resolve=>v.onseeked=resolve);v.currentTime=time;await seeked;const c=document.createElement('canvas');c.width=36;c.height=64;const ctx=c.getContext('2d');ctx.drawImage(v,0,0,36,64);return ctx.getImageData(0,0,36,64).data;}const expected=await pixels(URL.createObjectURL(window.__movieBlob),0.6);const actual=await pixels(document.querySelector('.movie-download').href,1.6);return actual.reduce((sum,value,index)=>sum+Math.abs(value-expected[index]),0)/actual.length;})()");
      assert.ok(recoveredFrameDifference < 15, `Native recovery retains video pixels: ${recoveredFrameDifference}`);
      assert.ok(Math.abs(finalVideo.duration - 2) < 0.2);
      assert.ok(finalVideo.size > rendered.size);
      assert.ok(finalVideo.pixel[0] > 200 && finalVideo.pixel[1] < 30 && finalVideo.pixel[2] < 30);
      assert.equal(finalVideo.audible, true);
      assert.deepEqual(await client.evaluate("Object.values(window.__exportReads)"), [1, 1, 1]);
      await client.evaluate("window.fetch=window.__renderFetch;void 0");
      await saveMovieArtifact(client, '.movie-download', 'export-mixed.mp4');
      const sourceHeaders = { Cookie: `media-session=${token}`, Origin: origin, 'X-Media-Client': 'web', 'X-Media-User': accountId, 'Content-Type': 'application/json' };
      await client.evaluate("document.querySelector('.movie-record-preview').click();void 0");
      await client.until("Boolean(document.querySelector('.movie-preview-download, .movie-editor .form-error')) && !document.querySelector('.movie-controls').disabled");
      assert.equal(await client.evaluate("document.querySelector('.movie-editor .form-error')?.textContent || ''"), '');
      assert.equal(await client.evaluate("(async()=>{const b=await(await fetch(document.querySelector('.movie-preview-download').href)).blob();const context=new AudioContext();const audio=await context.decodeAudioData(await b.arrayBuffer());const audible=audio.getChannelData(0).some(sample=>Math.abs(sample)>0.01);await context.close();return audible;})()"), true);
      await saveMovieArtifact(client, '.movie-preview-download', await client.evaluate("document.querySelector('.movie-preview-download').download.endsWith('.mp4') ? 'preview-mixed.mp4' : 'preview-mixed.webm'"));
      assert.equal((await fetch(origin + '/api/movie/sources/file', { method: 'POST', headers: sourceHeaders, body: JSON.stringify({ id: randomUUID() }) })).status, 404);
      assert.equal((await fetch(origin + '/api/movie/sources/list', { method: 'POST', headers: { ...sourceHeaders, Origin: 'https://other.example' }, body: JSON.stringify({ url: 'https://disk.yandex.ru/d/test' }) })).status, 403);
      assert.equal((await fetch(origin + '/api/movie/sources/list', { method: 'POST', headers: sourceHeaders, body: JSON.stringify({ url: 'https://127.0.0.1/private.png' }) })).status, 400);
      // Exercise importing photo + clip, partial failure, and cancelling a pending file.
      await client.evaluate(`window.__sourceFetch=window.fetch.bind(window);window.fetch=async(input,init)=>{
        if(input==='/api/movie/sources/list')return new Response(JSON.stringify({result:{files:[{id:'photo',name:'фото.png',type:'image/png',size:9},{id:'clip',name:'клип.mp4',type:'video/mp4',size:10},{id:'failed',name:'недоступное.png',type:'image/png',size:9}],skipped:1,truncated:false}}),{headers:{'Content-Type':'application/json'}});
        if(input==='/api/movie/sources/file') {const id=JSON.parse(init.body).id;if(id==='failed')return new Response(JSON.stringify({error:'Файл недоступен'}),{status:422,headers:{'Content-Type':'application/json'}});if(id==='clip')return new Response(window.__movieBlob,{headers:{'Content-Type':'video/mp4'}});const canvas=document.createElement('canvas');canvas.width=32;canvas.height=32;return new Response(await new Promise(resolve=>canvas.toBlob(resolve,'image/png')),{headers:{'Content-Type':'image/png'}});}
        return window.__sourceFetch(input,init);
      };const link=document.querySelector('.movie-source-import input');link.value='https://disk.yandex.ru/d/test';link.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.movie-source-import').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));void 0`);
      await client.until("document.querySelectorAll('.movie-material').length===5 && !document.querySelector('.movie-source-import input').disabled");
      assert.ok(await client.evaluate("document.querySelector('.movie-source-import [role=status]').textContent.includes('2')"));
      assert.equal(await client.evaluate("document.querySelectorAll('.movie-material')[3].querySelector('.movie-material-name').textContent.includes('фото.png')"), true);
      await client.evaluate(`window.fetch=(input,init)=>{
        if(input==='/api/movie/sources/list')return Promise.resolve(new Response(JSON.stringify({result:{files:[{id:'waiting',name:'waiting.png',type:'image/png',size:9}],skipped:0,truncated:false}}),{headers:{'Content-Type':'application/json'}}));
        if(input==='/api/movie/sources/file')return new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));return window.__sourceFetch(input,init);
      };document.querySelector('.movie-source-import').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));void 0`);
      await client.until("document.querySelector('.movie-source-import button[type=button]')");
      await client.evaluate("document.querySelector('.movie-source-import button[type=button]').click();void 0");
      await client.until("!document.querySelector('.movie-source-import input').disabled");
      assert.equal(await client.evaluate("document.querySelectorAll('.movie-material').length"), 5);
      await client.evaluate("window.fetch=window.__sourceFetch;void 0");
      const beforeAi = await client.evaluate("Array.from(document.querySelectorAll('.movie-material-name')).map(el=>el.textContent)");
      await client.until("document.querySelector('.movie-scenario select').options.length>0");
      await client.evaluate("{const el=document.querySelector('.movie-scenario textarea');el.value='Сделай короткий ролик про отпуск';el.dispatchEvent(new Event('input',{bubbles:true}));}void 0");
      await client.until("!document.querySelector('.movie-ai-generate').disabled");
      await client.evaluate("document.querySelector('.movie-ai-generate').click();void 0");
      await client.until("document.querySelectorAll('.movie-material').length===4 && document.querySelector('.movie-ai-undo') && !document.querySelector('.movie-ai-generate').disabled");
      await client.evaluate("document.querySelector('.movie-material').click();void 0");
      assert.equal(await client.evaluate("document.querySelector('.movie-scene textarea').value"), 'Отпуск');
      assert.deepEqual(await client.evaluate("Array.from(document.querySelectorAll('.movie-material-meta')).map(el=>el.textContent.match(/(?:· )([0-9.]+)/)[1])"), ['1', '1', '1', '1']);
      await client.evaluate("document.querySelector('.movie-ai-undo').click();void 0");
      assert.deepEqual(await client.evaluate("Array.from(document.querySelectorAll('.movie-material-name')).map(el=>el.textContent)"), beforeAi);
      // A billed text result with invalid material references must not mutate the montage.
      await client.evaluate("{const el=document.querySelector('.movie-scenario textarea');el.value='INVALID_PLAN_TEST';el.dispatchEvent(new Event('input',{bubbles:true}));}document.querySelector('.movie-ai-generate').click();void 0");
      await client.until("document.querySelector('.movie-scenario .form-error') && !document.querySelector('.movie-ai-generate').disabled");
      assert.match(await client.evaluate("document.querySelector('.movie-scenario .form-error').textContent"), /некорректный план|invalid plan/);
      assert.deepEqual(await client.evaluate("Array.from(document.querySelectorAll('.movie-material-name')).map(el=>el.textContent)"), beforeAi);
      const aiRecords = (await pool.query("SELECT data FROM media_records WHERE account_id=$1 AND namespace='codex'", [accountId])).rows;
      assert.equal(aiRecords.length, 2);
      assert.ok(aiRecords.every(row => row.data.kind === 'text' && row.data.state === 'success'));
      await client.evaluate("{const el=document.querySelector('.movie-scenario textarea');el.value='STOP_PLAN_TEST';el.dispatchEvent(new Event('input',{bubbles:true}));}document.querySelector('.movie-ai-generate').click();void 0");
      await client.until("document.querySelector('.movie-ai-stop')");
      await client.evaluate("document.querySelector('.movie-ai-stop').click();void 0");
      await client.until("!document.querySelector('.movie-ai-generate').disabled");
      assert.deepEqual(await client.evaluate("Array.from(document.querySelectorAll('.movie-material-name')).map(el=>el.textContent)"), beforeAi);
      await client.evaluate("document.querySelector('.movie-ai-generate').click();void 0");
      await client.until("document.querySelectorAll('.movie-material').length===4 && !document.querySelector('.movie-ai-generate').disabled");
      assert.equal(Number((await pool.query("SELECT count(*) FROM media_records WHERE account_id=$1 AND namespace='codex'", [accountId])).rows[0].count), 3);
      await client.evaluate("document.querySelector('.movie-ai-undo').click();void 0");
      assert.equal(await client.evaluate("(async()=>{const r=await fetch('/api/movie/errors',{method:'POST',headers:{'X-Media-Client':'web','X-Media-User':document.querySelector('meta[name=account-id]').content,'Content-Type':'application/json'},body:JSON.stringify({code:'ARBITRARY_CODE'})});return r.status;})()"), 400);
      assert.equal(await client.evaluate("(async()=>{const r=await fetch('/api/movie/errors',{method:'POST',headers:{'X-Media-Client':'web','X-Media-User':document.querySelector('meta[name=account-id]').content,'Content-Type':'application/json'},body:JSON.stringify({code:'MOVIE_RENDER_FAILED',failure:'https://private.test/secret'})});return r.status;})()"), 400);
      await client.until("/Черновик сохранён|Draft saved/.test(document.querySelector('.movie-draft-status')?.textContent || '')");
      const savedScenes = await client.evaluate("Array.from(document.querySelectorAll('.movie-material-name')).map(el=>el.textContent)");
      await client.evaluate("document.querySelector('.sidebar-history-link').click();void 0");
      await client.until("location.pathname==='/app/history'");
      await client.evaluate("document.querySelector('.sidebar-movie-link').click();void 0");
      await client.until("location.pathname==='/app/movie' && Boolean(document.querySelector('.movie-scene'))");
      assert.deepEqual(await client.evaluate("Array.from(document.querySelectorAll('.movie-material-name')).map(el=>el.textContent)"), savedScenes);
      assert.equal((await pool.query("SELECT data FROM media_records WHERE account_id=$1 AND namespace='movie-drafts'", [accountId])).rows[0].data.scenes.length, savedScenes.length);
      await client.evaluate("window.__movieBeforeReload=true;void 0");
      await client.command('Page.reload');
      await client.until("!window.__movieBeforeReload && document.readyState==='complete' && /Черновик сохранён|Draft saved/.test(document.querySelector('.movie-draft-status')?.textContent || '') && Boolean(document.querySelector('.movie-scene'))");
      assert.deepEqual(await client.evaluate("Array.from(document.querySelectorAll('.movie-material-name')).map(el=>el.textContent)"), savedScenes);
      assert.equal(await client.evaluate("document.querySelector('.movie-scenario textarea').value"), 'STOP_PLAN_TEST');
      const persistedDraft = (await pool.query("SELECT data FROM media_records WHERE account_id=$1 AND namespace='movie-drafts'", [accountId])).rows[0].data;
      assert.ok(persistedDraft.scenes.filter(scene=>scene.kind!=='title').every(scene=>scene.src.startsWith('/api/') && !scene.src.includes('blob:')));
      const persistentMedia = persistedDraft.scenes.find(scene=>scene.kind!=='title');
      assert.equal((await fetch(origin + persistentMedia.src, { headers: { Cookie: `media-session=${token}` } })).status, 200);
      // Match the reported timeline size after restoring persistent sources.
      for (let index = 0; index < 11; index++) {
        await client.evaluate("document.querySelector('.movie-title-add').click();void 0");
        await client.until(`document.querySelectorAll('.movie-material').length===${6 + index}`);
      }
      await client.evaluate("(async()=>{const tiles=Array.from(document.querySelectorAll('.movie-material'));for(let index=0;index<tiles.length;index++){tiles[index].click();await new Promise(resolve=>setTimeout(resolve,0));const el=document.querySelector('.movie-scene input[type=number]');el.value=[2,4].includes(index)?'1':'6.5';el.dispatchEvent(new Event('input',{bubbles:true}));const transition=document.querySelector('.movie-transition');transition.value='fade';transition.dispatchEvent(new Event('change',{bubbles:true}));}document.querySelector('.movie-render').click();})()");
      for (let attempt = 0; attempt < 2400; attempt++) {
        if (await client.evaluate("Boolean(document.querySelector('.movie-download, .movie-editor .form-error'))")) break;
        await sleep(100);
      }
      assert.equal(await client.evaluate("document.querySelector('.movie-editor .form-error')?.textContent || ''"), '');
      await client.until("document.querySelector('.movie-download')");
      const longDuration = await client.evaluate("(async()=>{const video=document.createElement('video');video.src=document.querySelector('.movie-download').href;await new Promise((resolve,reject)=>{video.onloadedmetadata=resolve;video.onerror=reject;});return video.duration;})()");
      assert.ok(Math.abs(longDuration - 85.5) < 0.1, `16-scene export duration: ${longDuration}`);
      await saveMovieArtifact(client, '.movie-download', 'export-16-scenes.mp4');
      console.log('Remotion E2E passed: MP4, import/cancel, AI workflow, draft storage, navigation and reload with readable media');
      return;
    }
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
    const codexModels = await client.evaluate("fetch('/api/codex/models').then(response=>response.json()).then(catalog=>catalog.models.map(model=>model.id))");
    const selectedCodexModel = codexModels[0];
    const otherCodexModel = codexModels[1];
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
    await client.evaluate("window.__autoQuoteFetch=window.fetch.bind(window);window.fetch=(input,init)=>{if(new URL(typeof input==='string'?input:input.url,location.origin).pathname!=='/api/auto/quote')return window.__autoQuoteFetch(input,init);const nano=JSON.parse(init.body).modelId==='nano-banana-pro.image';return Promise.resolve(new Response(JSON.stringify(nano?{selected:{providerId:'apimart',costUsd:0.03,nativeCredits:0.3,credits:0.3},offers:[{providerId:'kie',modelId:'kie:nano-banana-pro',costUsd:0.09,providerCredits:18,usdPerProviderCredit:0.005,credits:18},{providerId:'apimart',modelId:'gemini-3-pro-image-preview',costUsd:0.03,providerCredits:0.3,usdPerProviderCredit:0.1,credits:0.3}]}:{selected:{providerId:'apimart',costUsd:0.012,nativeCredits:0.12,credits:0.12},offers:[{providerId:'kie',modelId:'kie:gpt-image-2-text-to-image',costUsd:0.02,providerCredits:4,usdPerProviderCredit:0.005,credits:20},{providerId:'apimart',modelId:'gpt-image-2',costUsd:0.012,providerCredits:0.12,usdPerProviderCredit:0.1,credits:0.12}]}),{status:200,headers:{'Content-Type':'application/json'}}))};document.querySelector('.sidebar-provider-option[data-provider=auto]').click();void 0");
    await client.until("document.querySelector('.sidebar-provider-option.active')?.dataset.provider==='auto' && document.querySelector('.model-native-select option[value=\"gpt-image-2.text-to-image\"]') !== null");
    await client.evaluate("{const prompt=document.querySelector('.composer-body textarea');prompt.value='UI auto route';prompt.dispatchEvent(new Event('input',{bubbles:true}));}void 0");
    assert.equal(await client.evaluate("document.querySelectorAll('.auto-service-menus button').length"), 0);
    assert.equal(await client.evaluate("document.querySelector('.model-native-select option[value=\"apimart:gemini-3.1-flash-lite-image\"]') === null"), true);
    const autoOptions = await client.evaluate("Array.from(document.querySelectorAll('.model-native-select option'), option=>({value:option.value,label:option.textContent.trim()}))");
    assert.ok(autoOptions.length > 1);
    assert.ok(autoOptions.every(option => modelRoutes.models.some(row => row.id === option.value)));
    assert.equal(new Set(autoOptions.map(option => option.value)).size, autoOptions.length);
    assert.equal(autoOptions.filter(option => option.value === 'gpt-image-2.text-to-image').length, 1);
    assert.equal(autoOptions.filter(option => option.value === 'nano-banana-pro.image').length, 1);
    assert.equal(await client.evaluate("document.querySelector('.sidebar-provider-option.active')?.dataset.provider"), 'auto');
    await client.evaluate("window.__autoQuoteMockFetch=window.fetch.bind(window);window.fetch=(input,init)=>new URL(typeof input==='string'?input:input.url,location.origin).pathname==='/api/auto/quote'?Promise.resolve(new Response(JSON.stringify({selected:null,offers:[{providerId:'kie',modelId:'kie:example',unavailable:true,reason:'Kie tariff unavailable'},{providerId:'apimart',modelId:'example',credits:0.32,costUsd:0.032,unavailable:true,reason:'APIMart balance unavailable'}]}),{status:200,headers:{'Content-Type':'application/json'}})):window.__autoQuoteMockFetch(input,init);{const el=document.querySelector('.composer-body textarea');el.value='Unavailable route test';el.dispatchEvent(new Event('input',{bubbles:true}));}void 0");
    await client.until("document.querySelector('.auto-route-note')?.textContent.includes('APIMart balance unavailable')");
    assert.equal(await client.evaluate("document.querySelector('.generate-button').disabled"), true);
    await client.evaluate("document.querySelector('.auto-route-details-button').click();void 0");
    await client.until("document.querySelectorAll('.auto-route-table tbody tr').length===2");
    assert.match(await client.evaluate("document.querySelector('.auto-route-table').textContent"), /Kie tariff unavailable.*0[,.]32.*APIMart balance unavailable/s);
    await client.evaluate("document.querySelector('.auto-route-dialog .dialog-close').click();window.fetch=window.__autoQuoteMockFetch;void 0");

    await client.evaluate("{const select=document.querySelector('.model-native-select');select.value='gpt-image-2.text-to-image';select.dispatchEvent(new Event('change',{bubbles:true}));}void 0");
    await client.until("document.querySelector('.model-native-select')?.value==='gpt-image-2.text-to-image'");
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
    await client.evaluate("{const select=document.querySelector('.model-native-select');select.value='nano-banana-pro.image';select.dispatchEvent(new Event('change',{bubbles:true}));}void 0");
    await client.until("document.querySelector('.model-native-select')?.value==='nano-banana-pro.image' && /0[,.]03/.test(document.querySelector('.auto-route-note')?.textContent||'') && document.querySelector('.auto-route-details-button')");
    await client.evaluate("document.querySelector('.auto-route-details-button').click();void 0");
    await client.until("document.querySelectorAll('.auto-route-table tbody tr').length===2");
    assert.match(await client.evaluate("document.querySelector('.auto-route-dialog-model').textContent"), /Nano Banana Pro/);
    assert.match(await client.evaluate("document.querySelectorAll('.auto-route-table tbody tr')[0].textContent"), /Nano Banana Pro.*18.*\$0[,.]09/s);
    assert.match(await client.evaluate("document.querySelectorAll('.auto-route-table tbody tr')[1].textContent"), /Nano Banana Pro.*gemini-3-pro-image-preview.*0[,.]3.*\$0[,.]03/s);
    await client.evaluate("document.querySelector('.auto-route-dialog .dialog-close').click();const select=document.querySelector('.model-native-select');select.value='gpt-image-2.text-to-image';select.dispatchEvent(new Event('change',{bubbles:true}));void 0");
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
    if (codexWorker) {
      codexWorker.stopActive(); codexWorker.closeAllConnections();
      await new Promise(resolve => codexWorker.close(resolve));
    }
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
