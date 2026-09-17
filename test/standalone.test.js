const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

test('runtime resolves local modules and dependencies entirely inside the portable folder', () => {
  const root = path.resolve(__dirname, '..');
  const inside = file => assert.ok(file.startsWith(root + path.sep), `External dependency: ${file}`);
  assert.equal(require('../src/server/config').loadConfig({}).root, root);
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { visit(file); continue; }
      if (!/\.(js|mjs)$/.test(file)) continue;
      const resolve = createRequire(file);
      for (const match of fs.readFileSync(file, 'utf8').matchAll(/(?:require\(|import\(|from\s*)\s*['"]([^'"]+)['"]/g)) {
        const name = match[1];
        if (name.startsWith('node:')) continue;
        assert.notEqual(name, 'electron');
        inside(resolve.resolve(name));
      }
    }
  };
  visit(path.join(root, 'src'));
  visit(path.join(root, 'public'));
  inside(require.resolve('ajv'));
});
