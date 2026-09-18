const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

// Identify shipped application files, including when hosting mounts sources over /app.
function buildInfo(root = path.resolve(__dirname, '../..'), manifest = '/opt/media-build.json') {
  const hash = createHash('sha256');
  function add(relative) {
    const filename = path.join(root, relative);
    if (fs.statSync(filename).isDirectory()) {
      for (const name of fs.readdirSync(filename).sort()) add(relative + '/' + name);
    } else {
      const content = fs.readFileSync(filename);
      hash.update(relative + '\0' + content.length + '\0'); hash.update(content);
    }
  }
  for (const filename of ['package.json', 'server.js', 'src', 'public', 'config/native-prices.json', 'config/codex-models.json']) add(filename);
  const sourceId = hash.digest('hex');
  let builtAt = null;
  try {
    const saved = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (saved.sourceId === sourceId && Number.isFinite(Date.parse(saved.builtAt))) builtAt = saved.builtAt;
  } catch { /* Local source runs have no Docker build manifest. */ }
  return { version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, build: sourceId.slice(0, 12), sourceId, builtAt };
}
if (require.main === module) {
  fs.writeFileSync(process.argv[2], JSON.stringify({ ...buildInfo(), builtAt: new Date().toISOString() }) + '\n');
}
module.exports = { buildInfo };
