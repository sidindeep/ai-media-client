const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { resolveGitCommit } = require('../../scripts/resolve-git-commit.cjs');

// Identify shipped application files, including when hosting mounts sources over /app.
function buildInfo(root = path.resolve(__dirname, '../..'), manifest = '/opt/media-build.json', commitFile = '/opt/media-commit') {
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
  let commit = resolveGitCommit(path.join(root, '.git'));
  if (!commit) {
    try {
      const value = fs.readFileSync(commitFile, 'utf8').trim();
      if (/^[a-f0-9]{40,64}$/i.test(value)) commit = value.toLowerCase();
    } catch { /* Source runs may have no embedded commit. */ }
  }
  try {
    const saved = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (saved.sourceId === sourceId) {
      if (Number.isFinite(Date.parse(saved.builtAt))) builtAt = saved.builtAt;
      if (!commit && /^[a-f0-9]{40,64}$/i.test(saved.commit)) commit = saved.commit.toLowerCase();
    }
  } catch { /* Local source runs have no Docker build manifest. */ }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  return { version: pkg.version, channel: pkg.releaseChannel, commit, build: sourceId.slice(0, 12), sourceId, builtAt };
}
if (require.main === module) {
  fs.writeFileSync(process.argv[2], JSON.stringify({ ...buildInfo(undefined, undefined, process.argv[3]), builtAt: new Date().toISOString() }) + '\n');
}
module.exports = { buildInfo };
