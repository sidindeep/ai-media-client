const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

test('parameter captions switch locale without changing provider keys or contextual labels', async () => {
  const ts = require('typescript');
  function compile(source, requireModule = () => { throw new Error('Unexpected import'); }) {
    const exports = {};
    vm.runInNewContext(ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText, { exports, require: requireModule });
    return exports;
  }
  const ru = compile(await readFile(path.join(root, 'web/src/i18n/locales/ru.ts'), 'utf8')).ru;
  const en = compile(await readFile(path.join(root, 'web/src/i18n/locales/en.ts'), 'utf8')).en;
  let dictionary = ru;
  const labels = compile(await readFile(path.join(root, 'web/src/i18n/parameter-labels.ts'), 'utf8'), name => {
    if (name === './index') return { t: key => dictionary[key] };
    if (name === './locales/ru') return { ru };
    throw new Error(`Unexpected import: ${name}`);
  });
  assert.equal(labels.parameterLabel('acceleration'), 'Ускорение');
  assert.equal(labels.parameterLabel('description'), 'Описание');
  assert.equal(labels.parameterLabel('ratio'), 'Доля цвета');
  assert.equal(labels.parameterLabel('speaker_id'), 'ID спикера');
  assert.equal(labels.parameterLabel('seed', 'Seed'), 'Случайное зерно');
  const fields = [{ key: 'elements', label: 'elements', type: 'json', schema: { type: 'array' } }];
  const translated = labels.localizeParameterFields(fields);
  assert.equal(translated[0].label, 'Элементы');
  assert.equal(translated[0].key, 'elements');
  assert.equal(translated[0].schema, fields[0].schema);
  assert.equal(fields[0].label, 'elements');
  dictionary = en;
  assert.equal(labels.parameterLabel('acceleration'), 'Acceleration');
  assert.equal(labels.parameterLabel('speaker_id'), 'Speaker ID');
  assert.equal(labels.parameterLabel('elements', 'Elements 2'), 'Elements 2');
  assert.equal(labels.parameterLabel('ratio', 'Соотношение сторон'), 'Соотношение сторон');
  assert.equal(labels.parameterLabel('future_provider_field'), 'future_provider_field');
});

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

test('standalone pages have English text for every Russian static fragment', async () => {
  const script = await readFile(path.join(root, 'public/localization-en.js'), 'utf8');
  const context = { window: {} };
  vm.runInNewContext(script, context);
  const english = context.window.aiMediaEnglish;
  const pages = ['login.html', 'max-wait.html', 'max-confirm.html', 'admin.html', 'index.html',
    'legal/terms.html', 'legal/privacy.html', 'legal/personal-data-consent.html', 'legal/offer.html'];
  const missing = [];
  for (const page of pages) {
    const html = await readFile(path.join(root, 'public', page), 'utf8');
    assert.match(html, /src="\/localization-runtime\.js"/);
    const content = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
    const fragments = [...content.matchAll(/>([^<>]+)</g)].map(match => match[1]);
    fragments.push(...[...content.matchAll(/\b(?:title|placeholder|aria-label|alt|content)="([^"]+)"/g)].map(match => match[1]));
    for (const fragment of fragments) {
      const source = fragment.trim().replace(/\s+/g, ' ');
      if (/[А-Яа-яЁё]/u.test(source) && !english[source]) missing.push(`${page}: ${source}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('standalone localization switches exact and interpolated messages', async () => {
  const data = await readFile(path.join(root, 'public/localization-en.js'), 'utf8');
  const runtime = await readFile(path.join(root, 'public/localization-runtime.js'), 'utf8');
  const storage = new Map();
  const document = {
    nodeType: 9, documentElement: { lang: 'ru' }, querySelector: () => null, getElementById: () => null,
    createTreeWalker: () => ({ nextNode: () => false }),
  };
  const context = {
    window: { addEventListener() {}, dispatchEvent() {} }, document,
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    navigator: { languages: ['ru-RU'] }, Node: { TEXT_NODE: 3, ELEMENT_NODE: 1, DOCUMENT_NODE: 9 },
    NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4 }, MutationObserver: class { observe() {} },
    CustomEvent: class {}, location: { pathname: '/login' },
  };
  vm.runInNewContext(data, context);
  vm.runInNewContext(runtime, context);
  context.window.aiMediaLocale.set('en');
  assert.equal(document.documentElement.lang, 'en');
  assert.equal(context.window.aiMediaLocale.translate('Ваше пространство для генераций'), 'Your space for generation');
  assert.equal(context.window.aiMediaLocale.translate('Доступно: 25 кредитов · в резерве: 5'), 'Available: 25 credits · in reserve: 5');
  context.window.aiMediaLocale.set('ru');
  assert.equal(context.window.aiMediaLocale.translate('Ваше пространство для генераций'), 'Ваше пространство для генераций');
});
