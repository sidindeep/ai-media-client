const fs = require('node:fs');
const path = require('node:path');

function resolveGitCommit(gitPath) {
  try {
    const head = fs.readFileSync(path.join(gitPath, 'HEAD'), 'utf8').trim();
    if (/^[a-f0-9]{40,64}$/i.test(head)) return head.toLowerCase();
    const match = /^ref: (refs\/[\w./-]+)$/.exec(head);
    if (!match || match[1].split('/').includes('..')) return null;
    const ref = match[1];
    try {
      const value = fs.readFileSync(path.join(gitPath, ref), 'utf8').trim();
      if (/^[a-f0-9]{40,64}$/i.test(value)) return value.toLowerCase();
    } catch { /* A packed ref has no loose ref file. */ }
    const packed = fs.readFileSync(path.join(gitPath, 'packed-refs'), 'utf8');
    const line = packed.split(/\r?\n/).find(item => item.endsWith(` ${ref}`));
    const value = line?.split(' ')[0];
    return value && /^[a-f0-9]{40,64}$/i.test(value) ? value.toLowerCase() : null;
  } catch { return null; }
}

if (require.main === module) {
  const commit = resolveGitCommit(path.resolve(process.argv[2] || '.git'));
  if (!commit) { console.error('Cannot resolve Git HEAD for this Docker build'); process.exitCode = 1; }
  else process.stdout.write(`${commit}\n`);
}

module.exports = { resolveGitCommit };
