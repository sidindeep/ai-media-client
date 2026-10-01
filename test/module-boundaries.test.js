const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '../src');
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(path.join(directory, entry.name)) : entry.name.endsWith('.js') ? [path.join(directory, entry.name)] : []);
}

test('HTTP consumers use public operations without database pool or Codex transport access', () => {
  for (const file of [path.join(root, 'server/http.js'), ...files(path.join(root, 'server/routes'))]) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /accounts\.pool|\.query\s*\(/, path.relative(root, file));
    assert.doesNotMatch(source, /require\(['"][^'"]*(?:codex-billing|codex-worker|codex-records|worker-client|routerai-billing|routerai-records)['"]\)/, path.relative(root, file));
    assert.doesNotMatch(source, /config\.codex(?:\?|\.)/, path.relative(root, file));
  }
});

test('RouterAI orchestration and transport respect persistence and wallet boundaries', () => {
  const source = fs.readFileSync(path.join(root, 'services/routerai-billing.js'), 'utf8');
  assert.doesNotMatch(source, /\.query\s*\(|accounts\.|\bfetch(?:Impl)?\s*\(/);
  assert.doesNotMatch(source, /require\(['"][^'"]*(?:database|billing\/wallet|routerai\/client)['"]\)/);
  assert.match(source, /records\.create\(/);
  assert.match(source, /client\.chatCompletion\(/);
  for (const file of files(path.join(root, 'providers/routerai'))) {
    const imports = [...fs.readFileSync(file, 'utf8').matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(match => match[1]);
    for (const dependency of imports) assert.doesNotMatch(dependency,
      /(?:database|billing\/wallet|generations\/|accounts|generation-journal)/, path.relative(root, file));
  }
});

test('Codex application orchestration uses injected persistence and transport contracts', () => {
  const source = fs.readFileSync(path.join(root, 'services/codex-billing.js'), 'utf8');
  assert.doesNotMatch(source, /\.query\s*\(|accounts\.|\bfetch(?:Impl)?\s*\(/);
  assert.doesNotMatch(source, /require\(['"][^'"]*(?:database|billing\/wallet|worker-client)['"]\)/);
  assert.match(source, /records\.create\(/);
  assert.match(source, /worker\.submit\(/);
});

test('Codex worker and transports do not depend on application data or wallet modules', () => {
  const transport = /^codex-(?:worker|exec|app-server(?:-pool)?|request|images|login|runtime|usage|errors)\.js$/;
  for (const file of files(path.join(root, 'services')).filter(file => transport.test(path.basename(file)))) {
    const source = fs.readFileSync(file, 'utf8');
    const imports = [...source.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(match => match[1]);
    for (const dependency of imports) assert.doesNotMatch(dependency,
      /(?:database|billing\/|generations\/|accounts|content-service|generation-journal|codex-billing)/, path.relative(root, file));
    assert.doesNotMatch(source, /media_(?:wallets|reservations|records|ledger)/, path.relative(root, file));
  }
});
