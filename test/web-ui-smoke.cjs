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
  let runtime, win, directory;
  const pool = testPool();
  const timeout = setTimeout(() => { console.error('FAIL: web UI timeout'); app.exit(1); }, 45000);
  try {
    const artifacts = path.resolve(__dirname, '../artifacts'); await fs.mkdir(artifacts, { recursive: true });
    directory = await fs.mkdtemp(path.join(artifacts, 'web-ui-'));
    const config = { ...loadConfig({ MEDIA_PORT: '0' }), dataDirectory: directory,
      pricing: { version: 'ui-test', models: { 'kie:nano-banana-2-lite': { baseUnits: 1000 } } } };
    runtime = await start({ config, pool, provider: { id: 'kie', isConfigured: () => false }, authProviders: new Map() });
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
      throw new Error('UI condition timeout: ' + code);
    }
    await browserSession.cookies.set({ url: origin, name: 'media-session', value: userToken, httpOnly: true, sameSite: 'lax' });
    await win.loadURL(origin);
    await until("typeof draftsReady!=='undefined' && draftsReady && document.querySelector('#estimatedCost').textContent.includes('Цена: 1')");
    assert.equal(await evaluate("catalog.models.length"), 149);
    assert.equal(await evaluate("document.querySelector('#adminLink').hidden"), true);
    assert.equal(await evaluate("document.querySelector('#officialTariff')"), null);
    assert.equal(await evaluate("document.querySelector('#creditPackRub')"), null);
    assert.equal(await evaluate("document.querySelector('#provider').value"), 'media');
    await evaluate("document.querySelector('#tabSpending').click(); void 0");
    assert.equal(await evaluate("document.querySelector('#pageSpending').hidden"), false);
    assert.match(await evaluate("document.querySelector('#spendSummary').textContent"), /Списано за генерации/);
    await evaluate("document.querySelector('#logout').click(); void 0");
    await until("location.pathname==='/login' && document.querySelector('#loginProviders')!==null");
    await browserSession.cookies.set({ url: origin, name: 'media-session', value: adminToken, httpOnly: true, sameSite: 'lax' });
    await win.loadURL(origin + '/admin.html');
    await until("document.querySelector('#grantAccount').options.length===2");
    await evaluate(`document.querySelector('#grantAccount').value=${JSON.stringify(userId)};document.querySelector('#grantAmount').value='1.25';document.querySelector('#grantNote').value='Проверка UI';document.querySelector('#grantForm').requestSubmit();void 0`);
    await until("document.querySelector('#adminStatus').textContent==='Начисление сохранено'");
    assert.equal((await runtime.accounts.wallet.get(userId)).balanceUnits, 6250);
    assert.deepEqual(errors, []);
    console.log('PASS: web account UI, 149 models, native price and spending, hidden provider finance, logout, admin account list and exact credit grant.');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally {
    clearTimeout(timeout); win?.destroy();
    if (runtime) await runtime.close(); else await pool.end();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
    app.exit(process.exitCode || 0);
  }
});
