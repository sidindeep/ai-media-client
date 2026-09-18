const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createCodexLogin } = require('../src/services/codex-login');

test('Device login deduplicates, extracts only code, clears it on completion and kills cancellation', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-login-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const children = [], calls = [];
  const manager = createCodexLogin({ environment: () => ({ CODEX_HOME: path.join(directory, 'auth') }), launch: (file, args, options) => {
    calls.push({ file, args, options });
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; child.emit('close', null); };
    children.push(child); return child;
  } });
  t.after(() => manager.close());
  await Promise.all([manager.start(), manager.start()]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['login', '--device-auth']);
  assert.equal(calls[0].options.shell, undefined);
  assert.ok((await fs.stat(path.join(directory, 'auth'))).isDirectory());
  children[0].stderr.write('private token must never escape\n\x1b[32mABCD-');
  children[0].stderr.write('EF123\x1b[0m\n');
  assert.equal((await manager.status()).code, 'ABCD-EF123');
  assert.ok(!JSON.stringify(await manager.status()).includes('private'));
  children[0].emit('close', 0);
  await new Promise(resolve => setImmediate(resolve));
  const connected = manager.status(); children[1].emit('close', 0);
  assert.deepEqual(await connected, { state: 'connected' });
  await manager.start(); manager.cancel();
  assert.equal(children[2].killed, true);
  const check = manager.status(); children[3].emit('close', 1);
  assert.deepEqual(await check, { state: 'disconnected' });
  assert.deepEqual(calls[3].args, ['login', 'status']);
});

test('Device login timeout removes code and permits retry', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-login-timeout-'));
  const manager = createCodexLogin({ environment: () => ({ CODEX_HOME: directory }), timeoutMs: 20, launch: () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => child.emit('close', null); return child;
  } });
  t.after(async () => { manager.close(); await fs.rm(directory, { recursive: true, force: true }); });
  await manager.start(); await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(await manager.status(), { state: 'failed' });
  assert.equal((await manager.start()).state, 'running');
});
