const fs = require('node:fs');
const path = require('node:path');
const { models: kieModels } = require('../src/catalog');
const schemas = require('../config/apimart-schemas.json').models;
const routes = require('../config/model-routes.json').models;
const { describeModel } = require('../src/providers/apimart/catalog');
const { semanticKey } = require('../src/media/generation-task');
const root = path.resolve(__dirname, '..');
const fields = { kie: new Set(), apimart: new Set() };
const nested = { kie: new Set(), apimart: new Set() };
function schemaFields(schema, provider, prefix = '') {
  if (!schema || typeof schema !== 'object') return;
  for (const [key, value] of Object.entries(schema.properties || {})) {
    const field = prefix ? prefix + '.' + key : key;
    if (key !== '__input') (prefix ? nested : fields)[provider].add(field);
    schemaFields(value, provider, field);
  }
  if (schema.items && !Array.isArray(schema.items)) schemaFields(schema.items, provider, prefix + '[]');
  for (const type of ['allOf', 'oneOf', 'anyOf']) for (const variant of schema[type] || []) schemaFields(variant, provider, prefix);
}
function modelFields(model, provider) {
  schemaFields(model.inputSchema, provider);
  for (const field of model.fields || []) {
    if (field.key === '__input') continue;
    fields[provider].add(field.key);
    schemaFields(field.schema, provider, field.key);
  }
}
kieModels.forEach(model => modelFields(model, 'kie'));
for (const schema of Object.values(schemas)) modelFields(schema, 'apimart');
for (const row of routes) if (row.providers.apimart) {
  const model = describeModel({ id: row.providers.apimart, category: row.kind === 'text' ? 'chat' : row.kind });
  if (model) modelFields(model, 'apimart');
}
fields.apimart.add('prompt');

// A reference vocabulary, not executable conversion rules. Ambiguous aliases
// occur in more than one row and require the destination adapter's schema.
const extraAliases = {
  outputFormat: 'output_format', waterMark: 'watermark', safetyTolerance: 'safety_tolerance',
  promptUpsampling: 'prompt_upsampling', taskId: 'task_id',
  imageUrl: 'source_images', filesUrl: 'source_images', generate_audio: 'generate_audio',
  first_frame: 'first_frame', end_frame_image: 'last_frame',
};
const ambiguous = {
  mode: { targets: ['mode', 'resolution'], note: 'Может означать режим/уровень качества. Как resolution — только при подтверждённом соответствии адаптера (например, Kling 4k). Значения std/pro требуют отдельной проверки.' },
  quality: { targets: ['quality', 'resolution'], note: 'Качество изображения и разрешение видео — разные значения. Выбор смысла и допустимых значений делает адаптер.' },
  image_size: { targets: ['resolution', 'aspect_ratio'], note: 'В одних схемах разрешение, в других соотношение сторон. Контекст обязателен.' },
  size: { targets: ['aspect_ratio', 'size'], note: 'Соотношение сторон, пиксельный размер или специальный размер операции. Нельзя безусловно переводить в aspect_ratio.' },
  image_urls: { targets: ['source_images', 'reference_images'], note: 'Исходное изображение, референсы или упорядоченные кадры. Роль определяется выбранным действием и адаптером.' },
  video_urls: { targets: ['source_videos', 'reference_videos'], note: 'Исходное видео и видео-референс различаются по роли; названия недостаточно для выбора.' },
  video_list: { targets: ['video_list', 'reference_videos'], note: 'Может быть структурированным списком. Нельзя сводить к массиву URL с потерей ролей и метаданных.' },
};
const canonical = key => Object.hasOwn(extraAliases, key) ? extraAliases[key] : semanticKey(key);
const rows = new Map();
function add(id, provider, key, note = '') {
  if (!rows.has(id)) rows.set(id, { id, providers: { kie: [], apimart: [] }, notes: [] });
  const row = rows.get(id);
  if (!row.providers[provider].includes(key)) row.providers[provider].push(key);
  if (note && !row.notes.includes(note)) row.notes.push(note);
}
for (const provider of ['kie', 'apimart']) for (const key of fields[provider]) {
  const rule = ambiguous[key];
  for (const id of rule?.targets || [canonical(key)]) add(id, provider, key, rule?.note);
}
const parameters = [...rows.values()].sort((a, b) => a.id.localeCompare(b.id));
for (const row of parameters) for (const provider of ['kie', 'apimart']) row.providers[provider].sort();
const nestedRows = new Map();
for (const provider of ['kie', 'apimart']) for (const key of nested[provider]) {
  const parts = key.split('.');
  // Preserve object names and array positions; equal leaf names alone are not aliases.
  const id = [canonical(parts[0].replace(/\[\]$/, '')) + (parts[0].endsWith('[]') ? '[]' : ''), ...parts.slice(1)].join('.');
  if (!nestedRows.has(id)) nestedRows.set(id, { id, providers: { kie: [], apimart: [] } });
  nestedRows.get(id).providers[provider].push(key);
}
const nestedParameters = [...nestedRows.values()].sort((a, b) => a.id.localeCompare(b.id));
for (const provider of ['kie', 'apimart']) {
  const covered = new Set(parameters.flatMap(row => row.providers[provider]));
  if ([...fields[provider]].some(key => !covered.has(key))) throw new Error('Incomplete parameter vocabulary');
}
const inventory = {
  version: 'catalog-parameter-vocabulary-1',
  purpose: 'Reference vocabulary; adapters own contextual validation and conversion. Not loaded by runtime.',
  sourceCounts: Object.fromEntries(['kie', 'apimart'].map(provider => [provider, { fields: fields[provider].size, nested: nested[provider].size }])),
  parameters, nestedParameters,
};
fs.writeFileSync(path.join(root, 'config/parameter-correspondence.json'), JSON.stringify(inventory, null, 2) + '\n', 'utf8');
const escape = value => String(value || '—').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
const keys = array => array.length ? array.map(value => '`' + escape(value) + '`').join(', ') : '—';
const lines = ['# Общая таблица параметров Kie и APIMart', '',
  `Словарь: ${parameters.length} параметров верхнего уровня и ${nestedParameters.length} вложенных путей.`,
  `Kie: ${fields.kie.size} уникальных полей; APIMart: ${fields.apimart.size}.`, '',
  'Это полный снимок полей локальных каталогов проекта, а не обещание поддержки всех возможных полей API провайдеров.',
  'Таблица общая, без отдельных таблиц для моделей. Первые столбцы — провайдеры, последний — наш параметр.',
  'Словарь описывает соответствия названий. Он не загружен в runtime и не создаёт таблицу конвертаций в БД.',
  'Каждый адаптер общается только со своим провайдером и проверяет тип, допустимые значения, роль исходника и ограничения по его схеме.',
  'Одинаковое имя не гарантирует одинаковый смысл. При неоднозначности поле встречается в нескольких строках; условия перечислены ниже.',
  'Составные объекты и списки сохраняются целиком. Пустая ячейка означает отсутствие такого имени в текущем каталоге провайдера.', '',
  '## Все параметры', '', '| Kie | APIMart | Наш параметр |', '| --- | --- | --- |'];
for (const row of parameters) lines.push(`| ${keys(row.providers.kie)} | ${keys(row.providers.apimart)} | \`${escape(row.id)}\` |`);
lines.push('', '## Неоднозначные соответствия', '');
for (const [key, rule] of Object.entries(ambiguous)) lines.push(`- \`${key}\`: ${rule.note}`);
lines.push('', 'Имена, оставленные без объединения (например, `steps` и `num_inference_steps`, `guidance` и `cfg_scale`), требуют подтверждения одинаковой семантики; похожего названия недостаточно.', '',
  '## Вложенные параметры', '',
  '`[]` обозначает элемент массива. Вложенный `duration`, `prompt` или `type` не смешивается с одноимённым параметром всего запроса.', '',
  '| Kie | APIMart | Наш параметр |', '| --- | --- | --- |');
for (const row of nestedParameters) lines.push(`| ${keys(row.providers.kie)} | ${keys(row.providers.apimart)} | \`${escape(row.id)}\` |`);
lines.push('', '## Источники и обновление', '',
  '- Kie: `src/catalog`, схемы `inputSchema`, объединения вариантов и поля форм.',
  '- APIMart: `config/apimart-schemas.json`, каталог `src/providers/apimart/catalog.js` и ID из `config/model-routes.json`.',
  '- Основные подтверждённые синонимы: `src/media/generation-task.js`. Неоднозначные соответствия здесь — справочник для адаптеров, а не глобальные правила исполнения.',
  '- Обновить: `node scripts/sync-parameter-correspondence.cjs`.',
  '- Машиночитаемый снимок: `config/parameter-correspondence.json`.',
  '- `__input` — техническое поле редактора JSON, не параметр API; исключено.', '');
fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
fs.writeFileSync(path.join(root, 'docs/parameter-correspondence.md'), lines.join('\n'), 'utf8');
console.log(JSON.stringify({ parameters: parameters.length, nestedParameters: nestedParameters.length, sourceCounts: inventory.sourceCounts }));
