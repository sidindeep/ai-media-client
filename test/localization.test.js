const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');

function dictionaryKeys(source) {
  return new Set([...source.matchAll(/^\s*'([^']+)':/gm)].map(match => match[1]));
}

test('RU and EN localization dictionaries have matching keys', async () => {
  const [ru, en] = await Promise.all([
    readFile(path.join(root, 'web/src/i18n/locales/ru.ts'), 'utf8'),
    readFile(path.join(root, 'web/src/i18n/locales/en.ts'), 'utf8'),
  ]);
  assert.deepEqual([...dictionaryKeys(en)].sort(), [...dictionaryKeys(ru)].sort());
});

test('landing localization attributes reference known keys', async () => {
  const [ru, landing] = await Promise.all([
    readFile(path.join(root, 'web/src/i18n/locales/ru.ts'), 'utf8'),
    readFile(path.join(root, 'public/landing.html'), 'utf8'),
  ]);
  const keys = dictionaryKeys(ru);
  const references = [...landing.matchAll(/data-i18n(?:-html|-own|-aria-label|-title|-placeholder)?="([^"]+)"/g)].map(match => match[1]);
  assert.ok(references.length > 0);
  assert.deepEqual(references.filter(key => !keys.has(key)), []);
});
