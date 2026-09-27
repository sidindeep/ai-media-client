const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(filename) : /\.(?:js|cjs|mjs)$/.test(entry.name) ? [filename] : [];
  });
}

const files = [path.resolve('server.js'), ...sourceFiles(path.resolve('src'))];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(`${file}\n${result.stderr || result.stdout}`);
    process.exitCode = 1;
  }
}
if (!process.exitCode) process.stdout.write(`Checked ${files.length} backend files\n`);
