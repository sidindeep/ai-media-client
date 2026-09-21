// Rebuild the bundled catalog from public Kie OpenAPI documentation. No API key.
const fs = require('node:fs/promises');
const YAML = require('yaml');
const labels = { prompt:'Промпт', negative_prompt:'Негативный промпт', aspect_ratio:'Соотношение сторон', resolution:'Разрешение', duration:'Длительность, сек.', image_urls:'Референсные изображения', image_url:'Исходное изображение', tail_image_url:'Конечный кадр', end_image_url:'Конечный кадр', start_image_url:'Начальный кадр', cfg_scale:'Следование промпту', seed:'Seed', output_format:'Формат результата' };
async function get(url) {
  const response = await fetch(url, { headers:{ Accept:'text/markdown' }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}
function field(key, schema, required, properties) {
  const description = schema.description || '';
  const item = { key, label: labels[key] || key, required, schema, hint: description };
  if (key === 'image_url' && properties.tail_image_url) item.label = 'Начальный кадр';
  if (schema.enum) return { ...item, type:'select', options:schema.enum, default:schema.default };
  if ((schema.type === 'string' || schema.type === 'array' && schema.items?.type === 'string') && /image.*url|image_input|input_urls/.test(key)) {
    const mime = description.match(/image\/[a-z0-9.+-]+/gi);
    const size = description.match(/(?:max(?:imum)?\s*(?:file\s*)?size:?\s*)([\d.]+)\s*MB/i);
    return { ...item, type:'files', scalar:schema.type === 'string', accept: mime ? [...new Set(mime)].join(',') : 'image/*', maxFiles:schema.type === 'string' ? 1 : schema.maxItems, maxSizeMb:size ? Number(size[1]) : undefined };
  }
  if (schema.type === 'boolean') return { ...item, type:'boolean', default:schema.default };
  if (schema.type === 'number' || schema.type === 'integer') return { ...item, type:'number', min:schema.minimum, max:schema.maximum, step:schema.type === 'integer' ? 1 : 'any', default:schema.default };
  if (schema.type === 'array' || schema.type === 'object' || schema.oneOf || schema.anyOf) return { ...item, type:'json' };
  return { ...item, type:/prompt/.test(key) ? 'textarea' : 'text', maxLength:schema.maxLength, default:schema.default };
}
async function run() {
  const audioOnly = process.argv.includes('--only-audio');
  const index = await get('https://docs.kie.ai/llms.txt');
  const categoryPattern = audioOnly ? /^- Music Models/ : /^- (Image\s+Models|Video Models|Music Models)/;
  const entries = index.split('\n').filter(line => categoryPattern.test(line) && !line.includes('/cn/')).map(line => ({
    url:line.match(/\((https:[^)]+)\)/)?.[1],
    kind:line.startsWith('- Music Models') ? 'audio' : line.startsWith('- Video Models') ? 'video' : 'image'
  })).filter(e=>e.url);
  const models = [], skipped = [];
  let cursor = 0;
  await Promise.all(Array.from({length:6}, async () => {
    while(cursor < entries.length) {
      const {url,kind} = entries[cursor++];
      try {
        const markdown = await get(url);
        const block = markdown.match(/```ya?ml\s*\n([\s\S]*?)```/);
        if (!block) continue;
        const spec = YAML.parse(block[1]);
        const op = spec.paths?.['/api/v1/jobs/createTask']?.post;
        if (!op) { skipped.push({ url, reason:'Отдельный API' }); continue; }
        const schema = op.requestBody?.content?.['application/json']?.schema;
        const modelProperty=schema?.properties?.model;
        // A few Kie pages have a stale enum/default but state the real ID in the description.
        const documentedModel=modelProperty?.description?.match(/Must be\s+`([^`]+)`/i)?.[1];
        const apiModel = documentedModel || modelProperty?.default || modelProperty?.enum?.[0] || modelProperty?.examples?.[0];
        const input = schema?.properties?.input;
        if (!apiModel || !(input?.properties || input?.oneOf || input?.anyOf)) throw new Error('Не найдена схема input');
        const fields = input.properties ? Object.entries(input.properties).map(([key, value]) => field(key, value, (input.required || []).includes(key), input.properties)) : [{key:'__input',label:'Режим генерации',type:'json',required:true,schema:input}];
        models.push({ id:`kie:${apiModel}`, providerId:'kie', apiModel, name:op.summary || apiModel, kind, description:op.summary || apiModel, source:url, inputSchema:input,
          pricing:{type:'reported',label:'Стоимость до запуска пока не подключена'}, fields });
      } catch(error) { skipped.push({url,reason:error.message}); }
    }
  }));
  let unique = [...new Map(models.map(m=>[m.id,m])).values()];
  if (audioOnly) {
    const existing = JSON.parse(await fs.readFile('src/kie-models.json', 'utf8'));
    unique.sort((a,b)=>a.name.localeCompare(b.name));
    unique = [...existing.filter(model => model.kind !== 'audio'), ...unique];
  }
  else unique.sort((a,b)=>a.name.localeCompare(b.name));
  if (!unique.length) throw new Error('Каталог пуст; обновление отменено');
  await fs.writeFile('src/kie-models.json', JSON.stringify(unique,null,2));
  await fs.writeFile('src/kie-import-report.json', JSON.stringify({updatedAt:new Date().toISOString(), mode:audioOnly?'audio':'full', count:unique.length, skipped},null,2));
  console.log(JSON.stringify({models:unique.length,skipped},null,2));
}
module.exports = { field, get };
if (require.main === module) run().catch(error=>{console.error(error);process.exitCode=1;});
