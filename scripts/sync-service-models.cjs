const fs = require('node:fs');
const path = require('node:path');
const { models: kieModels } = require('../src/catalog');
const compatibility = require('../config/cost-routing-compatibility.json');
const kieMarket = require('../config/kie-market-models.json');

const root = path.resolve(__dirname, '..');
const tablePath = path.join(root, 'config/service-models.json');
const sharedTablePath = path.join(root, 'config/service-models-v2.json');
const candidatePath = path.join(root, 'config/service-model-candidates.json');
const documentPath = path.join(root, 'docs/model-correspondence.md');
const args = process.argv.slice(2);
const snapshotArgument = args.find(arg => !arg.startsWith('--'));
const snapshotPath = snapshotArgument && path.resolve(snapshotArgument);
const refreshNames = args.includes('--refresh-names');
const keepMarkdown = args.includes('--no-markdown');
const previous = fs.existsSync(candidatePath) ? JSON.parse(fs.readFileSync(candidatePath, 'utf8'))
  : fs.existsSync(tablePath) ? JSON.parse(fs.readFileSync(tablePath, 'utf8')) : { models: [] };
const snapshot = snapshotPath ? JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) : null;
const apimartModels = snapshot?.models || previous.models.flatMap(row => row.apimart ? [{ id: row.apimart, category: row.kind }] : []);
if (!apimartModels.length) throw new Error('Укажите снимок каталога APIMart первым аргументом');

// Same underlying model, including task variants that do not yet have a verified routing contract.
const additionalMatches = {
  'kie:bytedance/seedream-v4-edit': 'seedream-4-0',
  'kie:bytedance/seedream-v4-text-to-image': 'seedream-4-0',
  'kie:seedream/5-lite-image-to-image': 'seedream-5-0-lite',
  'kie:seedream/5-pro-image-to-image': 'seedream-5-0-pro',
  'kie:flux-kontext-pro': 'flux-kontext-pro',
  'kie:flux-kontext-max': 'flux-kontext-max',
  'kie:google/nano-banana-edit': 'gemini-2.5-flash-image-preview',
  'kie:kling-2.6/image-to-video': 'kling-v2-6',
  'kie:kling-2.6/motion-control': 'kling-v2-6-motion-control',
  'kie:kling-3.0/motion-control': 'kling-v3-motion-control',
  'kie:minimax-h3/image-to-video': 'MiniMax-H3',
  'kie:minimax-h3/reference-to-video': 'MiniMax-H3',
  'kie:pixverse-v6/image-to-video': 'pixverse-v6',
  'kie:pixverse-v6/reference-to-video': 'pixverse-v6',
  'kie:pixverse-v6/transition': 'pixverse-v6',
  'kie:pixverse-v6/extend': 'pixverse-v6',
  'kie:qwen3/image-to-image': 'qwen-image-3.0',
  'kie:qwen3/pro-image-to-image': 'qwen-image-3.0-pro',
  'kie:happyhorse-1-1/image-to-video': 'happyhorse-1.1',
  'kie:happyhorse-1-1/reference-to-video': 'happyhorse-1.1',
  'kie:wan/2-7-r2v': 'wan2.7-r2v',
  'kie:wan/2-7-videoedit': 'wan2.7-videoedit',
  'kie:veo3:TEXT_2_VIDEO': 'veo3.1-quality',
  'kie:veo3:FIRST_AND_LAST_FRAMES_2_VIDEO': 'veo3.1-quality',
  'kie:veo3_fast:TEXT_2_VIDEO': 'veo3.1-fast',
  'kie:veo3_fast:FIRST_AND_LAST_FRAMES_2_VIDEO': 'veo3.1-fast',
  'kie:veo3_fast:REFERENCE_2_VIDEO': 'veo3.1-fast',
  'kie:veo3_lite:TEXT_2_VIDEO': 'veo3.1-lite',
  'kie:veo3_lite:FIRST_AND_LAST_FRAMES_2_VIDEO': 'veo3.1-lite',
  'kie:veo3_lite:REFERENCE_2_VIDEO': 'veo3.1-lite',
};

const previousKie = new Map(previous.models.filter(row => row.kie).map(row => [row.kie, row]));
const previousApimartOnly = new Map(previous.models.filter(row => !row.kie && row.apimart).map(row => [row.apimart, row]));
const apimartPrices = new Map(previous.models.filter(row => row.apimart && row.apimartPrice)
  .map(row => [row.apimart, row.apimartPrice]));
const kiePrices = new Map(previous.models.filter(row => row.kie && row.kiePrice)
  .map(row => [row.kie, row.kiePrice]));
const apimartById = new Map(apimartModels.map(model => [model.id, model]));
const matchedApimart = new Set();

function displayName(id) {
  const brandNames = { gpt: 'GPT', chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini',
    grok: 'Grok', seedance: 'Seedance', seedream: 'Seedream', flux: 'FLUX',
    qwen: 'Qwen', wan: 'Wan', kling: 'Kling', minimax: 'MiniMax',
    imagen: 'Imagen', pixverse: 'PixVerse', happyhorse: 'HappyHorse',
    deepseek: 'DeepSeek', veo: 'Veo', ltx: 'LTX', suno: 'Suno',
    tts: 'TTS', whisper: 'Whisper', glm: 'GLM', kimi: 'Kimi',
    mimo: 'MiMo', midjourney: 'Midjourney', flowmusic: 'Flow Music',
    skyreels: 'SkyReels', viduq3: 'Vidu Q3' };
  const value = id.replace(/^(seedance|seedream)-(\d)-(\d)(?=-|$)/i, (_, brand, major, minor) => `${brand}-${major}.${minor}`);
  return value.split('-').map((part, index) => index === 0
    ? brandNames[part.toLowerCase()] || part[0].toUpperCase() + part.slice(1)
    : brandNames[part.toLowerCase()] || (/^[a-z]/.test(part) ? part[0].toUpperCase() + part.slice(1) : part)).join(' ');
}

function kieName(model) {
  const id = model.id;
  if (id === 'kie:seedream/5-pro-layer-decomposition') return 'Seedream 5.0 Pro — Layer Decomposition';
  if (id.startsWith('kie:happyhorse-1-1/')) {
    const action = id.split('/')[1].split('-').map(part => part[0].toUpperCase() + part.slice(1)).join(' ');
    return `HappyHorse 1.1 — ${action}`;
  }
  const name = model.name.trim().replace(/\s+/g, ' ')
    .replace(/^Bytedance\s+Seedance/i, 'Seedance')
    .replace(/^Flux-2/i, 'FLUX 2')
    .replace(/^GPT Image-([\d.]+)/i, 'GPT Image $1')
    .replace(/^Seedream(\d)/i, 'Seedream $1')
    .replace(/\s+[\u3400-\u9fff].*$/, '');
  return name;
}

const rows = kieModels.map(model => {
  const previousRow = previousKie.get(model.id);
  const apimart = previousRow?.apimart || compatibility.pairs.find(pair => pair.kie === model.id)?.apimart
    || additionalMatches[model.id] || null;
  if (apimart && !apimartById.has(apimart)) throw new Error(`Нет модели APIMart для ${model.id}: ${apimart}`);
  if (apimart) matchedApimart.add(apimart);
  return { kind: model.kind || 'image', apimart, kie: model.id,
    name: !refreshNames && previousRow?.name || kieName(model),
    apimartPrice: apimartPrices.get(apimart) || '', kiePrice: kiePrices.get(model.id) || '' };
});

function marketKind(apiModel) {
  if (/^(?:claude-|deepseek-|gemini-(?!omni)|gpt-(?!image)|grok-4-|kimi-k3)/.test(apiModel)) return 'text';
  if (/tts|speech|sound-effect|audio|generate-voice|generate-persona|^v3-api$/.test(apiModel)) return 'audio';
  if (/video|sora|veo|avatar|omni-human|infinitalk|runway|^wantest\/|^luma-/.test(apiModel)) return 'video';
  return 'image';
}
function marketMatch(apiModel) {
  const candidates = [apiModel,
    apiModel.replace(/^(gpt|gemini|grok)-(\d+)-(\d+)(?=-|$)/, '$1-$2.$3'),
    apiModel.replace(/^deepseek-v(\d+)-(\d+)(?=-|$)/, 'deepseek-v$1.$2')];
  return candidates.find(candidate => apimartById.has(candidate)) || null;
}
const localApiModels = new Set(kieModels.map(model => model.apiModel));
for (const apiModel of kieMarket.paths) {
  if (localApiModels.has(apiModel)) continue;
  const kie = `kie:${apiModel}`;
  const apimart = previousKie.get(kie)?.apimart || marketMatch(apiModel);
  if (apimart) matchedApimart.add(apimart);
  const old = previousKie.get(kie) || previousApimartOnly.get(apimart);
  rows.push({ kind: marketKind(apiModel), apimart, kie,
    name: !refreshNames && old?.name || displayName(apiModel.replaceAll('/', '-').replace(/(\d)-(\d)(?=-|$)/g, '$1.$2')),
    apimartPrice: apimartPrices.get(apimart) || '', kiePrice: kiePrices.get(kie) || '' });
}

for (const model of apimartById.values()) {
  if (matchedApimart.has(model.id)) continue;
  const prior = previousApimartOnly.get(model.id);
  rows.push({ kind: model.category === 'unknown' || model.category === 'chat' ? 'text' : model.category,
    apimart: model.id, kie: null, name: !refreshNames && prior?.name || (model.id === 'gemini-omni-1.1-flash'
      ? 'Gemini Omni 1.1 Flash — Standard' : displayName(model.id)),
    apimartPrice: apimartPrices.get(model.id) || '', kiePrice: '' });
}

const kindOrder = { text: 0, image: 1, video: 2, audio: 3 };
rows.sort((a, b) => (kindOrder[a.kind] ?? 4) - (kindOrder[b.kind] ?? 4)
  || a.name.localeCompare(b.name, 'en', { numeric: true })
  || String(a.kie || a.apimart).localeCompare(String(b.kie || b.apimart)));
const keys = new Set();
for (const row of rows) {
  const key = row.kie || `apimart:${row.apimart}`;
  if (keys.has(key)) throw new Error(`Повтор строки ${key}`);
  keys.add(key);
}
const version = new Date().toISOString();
const hasPrice = value => Boolean(value && value !== '—');
const pricedRows = rows.filter(row => hasPrice(row.apimartPrice) || hasPrice(row.kiePrice));
const table = { version, priceSnapshotAt: previous.priceSnapshotAt || null, models: pricedRows };
const sharedRows = pricedRows.filter(row => row.apimart && row.kie);
const sharedTable = { version: table.version, variant: 'shared', title: 'Наш сервис 2',
  baseVersion: table.version, priceSnapshotAt: table.priceSnapshotAt, models: sharedRows };
fs.writeFileSync(candidatePath, `${JSON.stringify({ version, priceSnapshotAt: table.priceSnapshotAt, models: rows }, null, 2)}\n`, 'utf8');
fs.writeFileSync(tablePath, `${JSON.stringify(table, null, 2)}\n`, 'utf8');
fs.writeFileSync(sharedTablePath, `${JSON.stringify(sharedTable, null, 2)}\n`, 'utf8');

const escape = value => String(value || '—').replace(/\|/g, '\\|');
const markdown = [
  '# Соответствие моделей APIMart, Kie и нашего сервиса',
  '',
  `Снимок каталога APIMart: ${table.version}. Модели без пары сохраняются отдельными строками.`,
  '«Наш сервис 1» содержит модели с ценой хотя бы одного провайдера; «Наш сервис 2» — модели с ID обоих провайдеров и ценой хотя бы одного. Наличие пары не означает, что оба маршрута уже подключены для запуска.',
  `Снимок цен: ${table.priceSnapshotAt || 'не указан'}. «—» означает, что цена в снимке не опубликована.`,
  'Совпадение модели в этой таблице не подтверждает совместимость параметров для автоматической маршрутизации; её задаёт `config/cost-routing-compatibility.json`.',
  '',
];
for (const [title, modelRows, sharedOnly] of [
  ['Наш сервис 1 — модели с ценой', pricedRows, false],
  ['Наш сервис 2 — модели обоих провайдеров', sharedRows, true],
]) {
  markdown.push(`## ${title}`, '');
  for (const kind of ['text', 'image', 'video', 'audio']) {
    if (sharedOnly) markdown.push(`### ${kind}`, '', '| APIMart | Цена APIMart | Kie | Цена Kie | Наш сервис 2 |', '|---|---|---|---|---|',
      ...modelRows.filter(row => row.kind === kind).map(row => `| ${escape(row.apimart)} | ${escape(row.apimartPrice).replaceAll('\n', '<br>')} | ${escape(row.kie)} | ${escape(row.kiePrice).replaceAll('\n', '<br>')} | ${escape(row.name)} |`), '');
    else markdown.push(`### ${kind}`, '', '| APIMart | Цена APIMart | Kie | Цена Kie | Наш сервис 1 | Наш сервис 2 |', '|---|---|---|---|---|---|',
      ...modelRows.filter(row => row.kind === kind).map(row => `| ${escape(row.apimart)} | ${escape(row.apimartPrice).replaceAll('\n', '<br>')} | ${escape(row.kie)} | ${escape(row.kiePrice).replaceAll('\n', '<br>')} | ${escape(row.name)} | ${row.apimart && row.kie ? escape(row.name) : '—'} |`), '');
  }
}
if (!keepMarkdown) fs.writeFileSync(documentPath, markdown.join('\n'), 'utf8');
console.log(JSON.stringify({ candidates: rows.length, rows: pricedRows.length, kie: kieModels.length, apimart: apimartById.size,
  pairedApimart: matchedApimart.size, sharedRows: sharedRows.length, tablePath, sharedTablePath, documentPath }));
