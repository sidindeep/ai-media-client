const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createKieEmbeddedBrowser } = require('../src/services/kie-embedded-browser');

test('embedded Kie browser starts once on demand, stops when idle, and can reopen', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kie-browser-lifecycle-'));
  const started = [];
  const spawnImpl = command => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = signal => {
      child.signalCode = signal;
      queueMicrotask(() => child.emit('exit', null, signal));
      return true;
    };
    started.push({ command, child });
    return child;
  };
  const control = createKieEmbeddedBrowser({ dataDirectory: path.join(directory, 'service'),
    cdpUrl: 'http://127.0.0.1:9222', idleMs: 40, spawnImpl, fetchImpl: async () => ({ ok: true }) });
  try {
    assert.equal(control.running(), false);
    assert.equal(started.length, 0);
    await Promise.all([control.ensureActive(), control.ensureActive()]);
    assert.equal(control.running(), true);
    assert.deepEqual(started.map(item => item.command), ['/usr/bin/Xvfb', '/usr/bin/chromium']);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(control.running(), false);
    assert.equal(started[0].child.signalCode, 'SIGTERM');
    assert.equal(started[1].child.signalCode, 'SIGTERM');
    await control.ensureActive();
    assert.equal(started.length, 4);
  } finally {
    await control.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
