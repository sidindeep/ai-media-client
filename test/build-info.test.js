const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildInfo } = require('../src/server/build-info');

test('version time survives missing or stale build manifests without using restart time', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-build-info-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = {
    'package.json': JSON.stringify({ version: '1.0.0', releaseChannel: 'debug' }),
    'server.js': '', 'src/app.js': '', 'public/version.js': '',
    'config/native-prices.json': '{}', 'config/codex-models.json': '{}',
  };
  for (const [relative, content] of Object.entries(files)) {
    const filename = path.join(root, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, content);
    fs.utimesSync(filename, new Date('2026-10-01T09:00:00Z'), new Date('2026-10-01T09:00:00Z'));
  }
  const manifest = path.join(root, 'build.json');
  const commitFile = path.join(root, 'commit');
  const initial = buildInfo(root, manifest, commitFile);
  assert.equal(initial.builtAt, null);
  assert.equal(initial.sourceUpdatedAt, '2026-10-01T09:00:00.000Z');
  assert.deepEqual(buildInfo(root, manifest, commitFile), initial);

  fs.writeFileSync(manifest, JSON.stringify({ sourceId: initial.sourceId, builtAt: '2026-10-01T10:00:00Z' }));
  assert.equal(buildInfo(root, manifest, commitFile).builtAt, '2026-10-01T10:00:00Z');

  const changedFile = path.join(root, 'src/app.js');
  fs.writeFileSync(changedFile, '// updated');
  fs.utimesSync(changedFile, new Date('2026-10-02T09:30:00Z'), new Date('2026-10-02T09:30:00Z'));
  const changed = buildInfo(root, manifest, commitFile);
  assert.equal(changed.builtAt, null);
  assert.equal(changed.sourceUpdatedAt, '2026-10-02T09:30:00.000Z');
  assert.notEqual(changed.sourceId, initial.sourceId);
});
