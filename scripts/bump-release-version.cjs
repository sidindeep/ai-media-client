const fs = require('node:fs');
const path = require('node:path');

const filename = path.resolve(__dirname, '../package.json');
const packageJson = JSON.parse(fs.readFileSync(filename, 'utf8'));
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(packageJson.version);
if (!match) throw new Error(`Ожидалась версия major.minor.patch, получено: ${packageJson.version}`);

const next = `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
packageJson.version = next;
fs.writeFileSync(filename, `${JSON.stringify(packageJson, null, 2)}\n`);
console.log(`Версия обновлена: ${match[0]} -> ${next}`);
