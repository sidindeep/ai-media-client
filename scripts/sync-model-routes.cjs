const fs = require('node:fs');
const path = require('node:path');
const { normalizeRows, validateDocument } = require('../src/services/model-route-document');
const root = path.resolve(__dirname, '..');
const fileArg = process.argv.slice(2).find(value => !value.startsWith('--'));
const source = fileArg ? path.resolve(fileArg) : path.join(root, 'config/model-routes.json');
const input = JSON.parse(fs.readFileSync(source, 'utf8'));
const document = validateDocument({ version: input.version, models: normalizeRows(input.models) });
fs.writeFileSync(path.join(root, 'config/model-routes.json'), JSON.stringify(document, null, 2) + '\n', 'utf8');
const providers = [...new Set(document.models.flatMap(row => Object.keys(row.providers)))].sort((a, b) =>
  (a === 'kie' ? 0 : a === 'apimart' ? 1 : 2) - (b === 'kie' ? 0 : b === 'apimart' ? 1 : 2) || a.localeCompare(b));
const escape = value => String(value || '—').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
const lines = ['# Единая таблица моделей', '',
  `Версия: ${document.version}. Строк: ${document.models.length}.`, '',
  'Первые столбцы — роутеры, последний — стабильный ID модели/действия в проекте.',
  'Пустая ячейка означает отсутствие соответствия. Параметры и API-запрос формируют адаптеры.',
  'Таблица охватывает полный каталог; меню показывает модели с опубликованным тарифом.', '',
  '`action` задаёт режим задачи. `auto` означает универсальную модель: режим определяется параметрами в адаптере.',
  'Для отдельных действий режим обязателен; адаптер исключает маршрут при несовместимых данных или отсутствии исходника.', '',
  'Для Grok Imagine старые действия сопоставлены с legacy-моделями APIMart 1.0;',
  'совместимость конкретных параметров проверяется адаптером, платные генерации не входят в синхронизацию.', ''];
for (const kind of ['text', 'image', 'video', 'audio']) {
  lines.push(`## ${kind}`, '', `| ${[...providers, 'Режим', 'Наш ID в проекте'].join(' | ')} |`,
    `| ${[...providers, 'action', 'id'].map(() => '---').join(' | ')} |`);
  for (const row of document.models.filter(row => row.kind === kind))
    lines.push(`| ${[...providers.map(provider => escape(row.providers[provider]?.replace(/^kie:/, ''))), escape(row.action), escape(row.id)].join(' | ')} |`);
  lines.push('');
}
fs.writeFileSync(path.join(root, 'docs/model-correspondence.md'), lines.join('\n'), 'utf8');
console.log(JSON.stringify({ models: document.models.length, providers, document: 'docs/model-correspondence.md' }));
