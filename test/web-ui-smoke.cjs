// Hidden browser verification; isolated PostgreSQL engine, no live credentials or provider requests.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const { testPool } = require('./helpers/pg-pool');
const { start } = require('../server');
const { loadConfig } = require('../src/server/config');
const { hash } = require('../src/auth/service');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  let runtime, win, directory, codexWorker, codexRequest;
  const pool = testPool();
  const timeout = setTimeout(() => { console.error('FAIL: web UI timeout'); app.exit(1); }, 45000);
  try {
    const artifacts = path.resolve(__dirname, '../artifacts'); await fs.mkdir(artifacts, { recursive: true });
    directory = await fs.mkdtemp(path.join(artifacts, 'web-ui-'));
    let loginState = { state: 'disconnected' };
    codexWorker = require('../src/services/codex-worker').createCodexWorker(async request => {
      codexRequest = request;
      return request.kind === 'image' ? { output: 'Тестовый ответ Codex', imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' } : 'Тестовый ответ Codex';
    }, { login: {
      status: async () => loginState,
      start: async () => (loginState = { state: 'running', code: 'ABCD-EF123' }),
      cancel: () => (loginState = { state: 'idle' }), close() {},
    } });
    await new Promise(resolve => codexWorker.listen(0, '127.0.0.1', resolve));
    const config = { ...loadConfig({ MEDIA_PORT: '0' }), dataDirectory: directory,
      codex: { url: `http://127.0.0.1:${codexWorker.address().port}` },
      pricing: { version: 'ui-test', models: { 'kie:nano-banana-2-lite': { baseUnits: 1000 }, 'codex:gpt-5.6-sol:ultra:fast': { baseUnits: 1000 } } } };
    runtime = await start({ config, pool, provider: { id: 'kie', isConfigured: () => false }, authProviders: new Map() });
    const originalUser = runtime.auth.user.bind(runtime.auth);
    let fileDropAttempts = 0;
    runtime.auth.user = async req => {
      if (req.url === '/shared/file-drop.js' && ++fileDropAttempts === 1) {
        throw Object.assign(new Error('Connection terminated'), { code: 'ECONNRESET' });
      }
      return originalUser(req);
    };
    const userId = randomUUID(), adminId = randomUUID(), userToken = randomBytes(32).toString('base64url'), adminToken = randomBytes(32).toString('base64url');
    for (const [id, role, token] of [[userId, 'user', userToken], [adminId, 'admin', adminToken]]) {
      await pool.query('INSERT INTO media_accounts(id,display_name,role) VALUES($1,$2,$3)', [id, role === 'user' ? 'Пользователь' : 'Администратор', role]);
      await pool.query('INSERT INTO media_wallets(account_id,balance) VALUES($1,5000)', [id]);
      await pool.query("INSERT INTO media_sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [hash(token), id]);
    }
    const origin = `http://localhost:${runtime.server.address().port}`;
    const browserSession = session.fromPartition(`web-ui-${randomUUID()}`);
    win = new BrowserWindow({ show: false, webPreferences: { session: browserSession, nodeIntegration: false, contextIsolation: true, sandbox: true } });
    const errors = [];
    win.webContents.on('console-message', (_event, level, message) => { if (level === 3) errors.push(message); });
    const evaluate = code => win.webContents.executeJavaScript(code);
    async function until(code) {
      for (let count = 0; count < 100; count++) { if (await evaluate(code)) return; await new Promise(resolve => setTimeout(resolve, 50)); }
      throw new Error('UI condition timeout: ' + code + ' · ' + await evaluate("document.querySelector('#codexStatus')?.textContent || ''"));
    }
    await browserSession.cookies.set({ url: origin, name: 'media-session', value: userToken, httpOnly: true, sameSite: 'lax' });
    await (await runtime.accounts.get(userId)).dispatch('saveDrafts', [{ version: 1, active: 0, tabs: [{ provider: 'kie', model: 'kie:nano-banana-2-lite', values: { prompt: { value: 'Черновик после смены роли' } }, sourceFiles: [] }] }]);
    await win.loadURL(origin);
    await until("typeof draftsReady!=='undefined' && draftsReady && document.querySelector('#estimatedCost').textContent.includes('Цена: 1')");
    assert.equal(await evaluate("catalog.models.length"), 149);
    const codexCatalog = require('../config/codex-models.json');
    await until("document.querySelector('#codexModel')?.disabled===false");
    assert.deepEqual(await evaluate("Array.from(document.querySelector('#codexModel').options, option=>option.value)"), codexCatalog.models.map(model=>model.id));
    const mediaModelBefore = await evaluate("document.querySelector('#model').value");
    await evaluate("document.querySelector('#codexModel').selectedIndex=1;document.querySelector('#codexModel').dispatchEvent(new Event('change'));void 0");
    assert.equal(await evaluate("document.querySelector('#model').value"), mediaModelBefore);
    assert.equal(await evaluate("document.querySelector('#codexModelDetails').textContent"), 'Низкий');
    await evaluate("document.querySelector('#generationProvider').value='codex';document.querySelector('#generationProvider').dispatchEvent(new Event('change'));void 0");
    assert.equal(await evaluate("document.querySelector('#kieGeneration').hidden"), true);
    assert.equal(await evaluate("document.querySelector('#codexGeneration').hidden"), false);
    await evaluate("document.querySelector('#codexEffort').value='5';document.querySelector('#codexEffort').dispatchEvent(new Event('input'));document.querySelector('#codexSpeed').value='fast';document.querySelector('#codexSpeed').dispatchEvent(new Event('change'));void 0");
    assert.match(await evaluate("document.querySelector('#codexRoute').textContent"), /Codex CLI.*Ультра.*Fast/);
    await until("!document.querySelector('#codexSubmit').disabled");
    await evaluate("document.querySelector('#codexPrompt').value='Запрос обычного пользователя';document.querySelector('#codexForm').requestSubmit();void 0");
    await until("document.querySelector('#codexOutput').textContent==='Тестовый ответ Codex'");
    assert.equal((await runtime.accounts.wallet.get(userId)).balanceUnits, 4000);
    const userCodexJob = codexRequest.requestId;
    assert.equal(codexRequest.kind, 'image');
    await until("document.querySelector('#codexImage').complete && document.querySelector('#codexImage').naturalWidth===1");
    assert.equal(await evaluate("document.querySelector('#codexImageResult').hidden"), false);
    assert.equal((await browserSession.fetch(origin + '/api/codex/jobs/' + userCodexJob + '/image?download=1')).headers.get('content-type'), 'image/png');
    await evaluate("document.querySelector('#generationProvider').value='kie';document.querySelector('#generationProvider').dispatchEvent(new Event('change'));void 0");
    assert.equal(fileDropAttempts, 2, 'file-drop script recovers from a transient session lookup failure');
    assert.equal(await evaluate("typeof window.attachFileDrop"), 'function');
    assert.ok(await evaluate("document.querySelector('#fields .file-drop-zone input[type=file]') !== null"));
    assert.equal(await evaluate("document.querySelector('#status').textContent.includes('attachFileDrop')"), false);
    assert.equal(await evaluate("document.querySelector('[data-key=prompt]').value"), 'Черновик после смены роли');
    await evaluate('saveWorkspaceDrafts()');
    await until("document.querySelector('#balance').textContent==='4'");
    assert.equal(await evaluate("document.querySelector('#adminLink').hidden"), true);
    assert.equal(await evaluate("document.querySelector('#officialTariff')"), null);
    assert.equal(await evaluate("document.querySelector('#creditPackRub')"), null);
    assert.equal(await evaluate("document.querySelector('#provider').value"), 'media');
    await until("document.querySelector('#menuName')?.textContent==='Пользователь'");
    await evaluate("document.querySelector('#accountDropdown').open=true;document.querySelector('#menuProfile').click();void 0");
    await until("document.querySelector('#accountDialog').open");
    await evaluate("document.querySelector('#profileName').value='Новое имя';document.querySelector('#profileForm').requestSubmit();void 0");
    await until("document.querySelector('#accountDialogStatus').textContent==='Имя сохранено'");
    assert.equal((await pool.query('SELECT display_name FROM media_accounts WHERE id=$1', [userId])).rows[0].display_name, 'Новое имя');
    await evaluate("document.querySelector('#closeAccountDialog').click();document.querySelector('#menuSettings').click();void 0");
    await until("document.querySelector('#accountDialog').open && !document.querySelector('#accountSettingsForm').hidden");
    await evaluate("document.querySelector('#accountConcurrency').value='2';document.querySelector('#accountAutoSave').checked=true;document.querySelector('#accountSettingsForm').requestSubmit();void 0");
    await until("document.querySelector('#accountDialogStatus').textContent==='Настройки сохранены'");
    assert.equal((await runtime.accounts.get(userId)).queue.concurrency, 2);
    await evaluate("document.querySelector('#closeAccountDialog').click();document.querySelector('#menuTopup').click();void 0");
    await until("document.querySelector('#accountDialog').open && !document.querySelector('#topupInfo').hidden");
    await evaluate("document.querySelector('#closeAccountDialog').click();void 0");
    await evaluate("document.querySelector('#tabSpending').click(); void 0");
    assert.equal(await evaluate("document.querySelector('#pageSpending').hidden"), false);
    assert.match(await evaluate("document.querySelector('#spendSummary').textContent"), /Списано за генерации/);
    await evaluate("document.querySelector('#logout').click(); void 0");
    await until("location.pathname==='/login' && document.querySelector('#loginProviders')!==null");
    await browserSession.cookies.set({ url: origin, name: 'media-session', value: adminToken, httpOnly: true, sameSite: 'lax' });
    assert.equal((await browserSession.fetch(origin + '/api/codex/jobs/' + userCodexJob)).status, 404);
    assert.equal((await browserSession.fetch(origin + '/api/codex/jobs/' + userCodexJob + '/image')).status, 404);
    await win.loadURL(origin + '/?account=' + userId);
    await until("typeof draftsReady!=='undefined' && draftsReady");
    assert.equal(await evaluate("document.querySelector('[data-key=prompt]').value"), 'Черновик после смены роли');
    assert.equal(await evaluate("document.querySelector('#provider').value"), 'kie');
    await win.loadURL(origin + '/admin.html#credits');
    await until("document.querySelector('#grantAccount').options.length===2");
    await evaluate("location.hash='codexPanel';void 0");
    await until("document.querySelector('#codexLoginStatus').textContent==='Codex ещё не подключён.'");
    await evaluate("document.querySelector('#codexLoginStart').click();void 0");
    await until("document.querySelector('#codexLoginCode').textContent==='ABCD-EF123'");
    assert.equal(await evaluate("document.querySelector('#codexLoginStart').disabled"), true);
    assert.equal(await evaluate("document.querySelector('#codexLoginInstructions').hidden"), false);
    await evaluate("document.querySelector('#codexLoginCancel').click();void 0");
    await until("document.querySelector('#codexLoginInstructions').hidden && !document.querySelector('#codexLoginStart').disabled");
    await evaluate("document.querySelector('#codexLoginStart').click();void 0");
    await until("document.querySelector('#codexLoginCode').textContent==='ABCD-EF123'");
    loginState = { state: 'connected' };
    await until("document.querySelector('#codexLoginStatus').textContent.includes('Codex подключён.')");
    assert.equal(await evaluate("document.querySelector('#codexLoginCode').textContent"), '');
    await evaluate("location.hash='credits';void 0");
    assert.equal(await evaluate("document.querySelector('#grantAccount').value"), adminId);
    assert.match(await evaluate("document.querySelector('#grantBalance').textContent"), /Доступно: 5/);
    await evaluate("document.querySelector('#grantAmount').value='2.125';document.querySelector('#grantNote').value='Пополнение своего счёта';document.querySelector('#grantForm').requestSubmit();void 0");
    await until("document.querySelector('#grantBalance').textContent.includes('7,125') && !document.querySelector('#grantForm button').disabled");
    assert.equal((await runtime.accounts.wallet.get(adminId)).balanceUnits, 7125);
    await evaluate(`document.querySelector('#grantAccount').value=${JSON.stringify(userId)};document.querySelector('#grantAmount').value='1.25';document.querySelector('#grantNote').value='Проверка UI';document.querySelector('#grantForm').requestSubmit();void 0`);
    await until("document.querySelector('#grantBalance').textContent.includes('5,25') && !document.querySelector('#grantForm button').disabled");
    assert.equal((await runtime.accounts.wallet.get(userId)).balanceUnits, 5250);
    await evaluate("document.querySelector('#grantSelf').click(); void 0");
    await until(`document.querySelector('#grantAccount').value===${JSON.stringify(adminId)}`);
    assert.match(await evaluate("document.querySelector('#grantBalance').textContent"), /7,125/);
    const notes = (await pool.query("SELECT note FROM media_ledger WHERE kind='grant' ORDER BY created_at")).rows.map(row => row.note);
    assert.deepEqual(notes, ['Пополнение своего счёта', 'Проверка UI']);
    await win.loadURL(origin);
    await until("!document.querySelector('#codexModel').disabled");
    await evaluate("document.querySelector('#generationProvider').value='codex';document.querySelector('#generationProvider').dispatchEvent(new Event('change'));document.querySelector('#codexModel').value='gpt-5.6-sol';document.querySelector('#codexModel').dispatchEvent(new Event('change'));document.querySelector('#codexEffort').value='5';document.querySelector('#codexEffort').dispatchEvent(new Event('input'));document.querySelector('#codexSpeed').value='fast';document.querySelector('#codexSpeed').dispatchEvent(new Event('change'));document.querySelector('#codexPrompt').value='Проверка маршрута';void 0");
    await until("!document.querySelector('#codexSubmit').disabled");
    await evaluate("document.querySelector('#codexForm').requestSubmit();void 0");
    await until("document.querySelector('#codexOutput').textContent==='Тестовый ответ Codex'");
    assert.equal(codexRequest.effort, 'ultra'); assert.equal(codexRequest.speed, 'fast'); assert.equal(codexRequest.model, 'gpt-5.6-sol');
    assert.equal((await runtime.accounts.wallet.get(adminId)).balanceUnits, 6125);
    await win.loadURL(origin + '/admin.html');
    await until("document.querySelector('#grantAccount').options.length===2");
    await evaluate(`location.hash='accountsPanel';document.querySelector('button[data-account-id="${userId}"]').click();void 0`);
    await until("document.querySelector('#roleDialog').open");
    await evaluate("document.querySelector('#roleValue').value='admin';document.querySelector('#roleReason').value='Назначение через панель';document.querySelector('#roleForm').requestSubmit();void 0");
    await until("document.querySelector('#adminStatus').textContent==='Роль сохранена' && !document.querySelector('#roleDialog').open");
    assert.equal((await pool.query('SELECT role FROM media_accounts WHERE id=$1', [userId])).rows[0].role, 'admin');
    assert.equal((await pool.query('SELECT reason FROM media_role_audit WHERE account_id=$1', [userId])).rows[0].reason, 'Назначение через панель');
    assert.deepEqual(errors, []);
    console.log('PASS: web account UI, 149 models, native price and spending, hidden provider finance, logout, admin account list and exact credit grant.');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally {
    clearTimeout(timeout); win?.destroy();
    if (runtime) await runtime.close(); else await pool.end();
    if (codexWorker) { codexWorker.closeIdleConnections(); await new Promise(resolve => codexWorker.close(resolve)); }
    if (directory) await fs.rm(directory, { recursive: true, force: true });
    app.exit(process.exitCode || 0);
  }
});
