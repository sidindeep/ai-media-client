// Refresh public model parameter metadata. No API key or generation is needed.
// Run: node scripts/sync-apimart-schemas.cjs
const fs = require('node:fs/promises');
const path = require('node:path');
const base = 'https://docs.apimart.ai';
const labels = {
  size: 'Размер / формат', aspect_ratio: 'Соотношение сторон', resolution: 'Разрешение', quality: 'Качество',
  duration: 'Длительность, сек.', length: 'Длительность, сек.', n: 'Количество', num_images: 'Количество',
  mode: 'Режим', version: 'Версия', image_urls: 'Изображения', video_urls: 'Видео', audio_urls: 'Аудио',
  image: 'Изображение', video: 'Видео', image_url: 'Изображение', video_url: 'Видео', audio_url: 'Аудио',
  first_frame_image: 'Первый кадр', last_frame_image: 'Последний кадр', mask: 'Маска',
  generate_audio: 'Генерировать звук', audio: 'Генерировать звук', sound: 'Звук',
  seed: 'Seed', negative_prompt: 'Негативный промпт', title: 'Название', tags: 'Стиль',
  instrumental: 'Без вокала', custom: 'Собственный текст', output_format: 'Формат файла',
  prompt_extend: 'Расширять промпт', prompt_optimizer: 'Улучшать промпт', watermark: 'Водяной знак',
  background: 'Фон', style: 'Стиль', fps: 'Частота кадров', voice: 'Голос', speed: 'Скорость',
};
async function read(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`${response.status}: ${url}`);
  return response.text();
}
function params(markdown) {
  const tokens = /<ParamField\b((?:"[^"]*"|'[^']*'|[^'">])*)>|<\/ParamField>/g;
  const output = [];
  let depth = 0, start, attrs, required;
  for (const match of markdown.matchAll(tokens)) {
    if (match[1] !== undefined) {
      if (depth++ === 0) {
        attrs = Object.fromEntries([...match[1].matchAll(/(\w+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
        required = /\brequired\b/.test(match[1]);
        start = match.index + match[0].length;
      }
    } else if (--depth === 0 && attrs.body) output.push({ ...attrs, required, text: markdown.slice(start, match.index) });
  }
  return output;
}
function tableParams(markdown) {
  return [...markdown.matchAll(/^\|\s*`([a-z_]+)`\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*(.*?)\s*\|\s*$/gm)].map(match => ({
    body: match[1], type: match[2].trim().replace('string\\[]', 'array<string>').replace(/^int$/, 'integer')
      .replace(/^bool$/, 'boolean').replace(/^float$/, 'number'),
    required: match[3].trim() === 'Yes', text: match[4],
    ...(match[1] === 'speed' && match[4].includes('relax') ? { default: 'relax' } : {}),
  }));
}
function field(param) {
  const rawType = param.type || 'string';
  const type = /^(integer|number)/.test(rawType) ? 'number' : rawType === 'boolean' ? 'boolean'
    : /array|object/.test(rawType) ? 'json' : 'string';
  const result = { key: param.body, label: labels[param.body] || param.body, type, required: param.required };
  if (type === 'json') {
    result.schema = /^array/.test(rawType) ? { type: 'array', items: /object/.test(rawType) || params(param.text).length ? { type: 'object' }
      : /string|url/.test(rawType) || /_urls$/.test(param.body) ? { type: 'string' } : {} }
      : { type: 'object' };
  }
  if (type === 'string' || type === 'number') {
    const choices = [...param.text.matchAll(/^\s*[*-]\s+`([^`]+)`/gm)].map(m => m[1]);
    if (choices.length >= 2 && choices.length <= 30 && /Options|Supported (?:values|resolutions|sizes|formats)|Available (?:values|options)|Possible values/i.test(param.text)) {
      const values = choices.filter(value => !/\s|https?:|\[|\{|\*/.test(value) && value.length < 30);
      if (values.length === choices.length) result.options = [...new Set(values.map(value => type === 'number' ? Number(value) : value))];
    }
    if (param.body === 'speed' && /`relax`/.test(param.text)) result.options = ['relax', 'fast', 'turbo'];
    const exactTokens = { size: /^(?:\d+(?::|x)\d+|auto|adaptive)$/, aspect_ratio: /^(?:\d+:\d+|auto|adaptive)$/,
      resolution: /^(?:\d+(?:\.\d+)?(?:p|k|mp)|auto)$/i, quality: /^(?:auto|low|medium|high|standard|hd)$/ };
    if (exactTokens[param.body]) {
      let values = [...new Set([...param.text.matchAll(/`([^`]+)`/g)].map(m => m[1]).filter(value => exactTokens[param.body].test(value)))];
      if (param.body === 'size' && values.some(value => value.includes(':'))) values = values.filter(value => !value.includes('x'));
      if (values.length > 1) result.options = values;
    }
  }
  // API defaults are display hints; model variants in one page may have different defaults.
  if (param.default) {
    result.hint = `По умолчанию: ${param.default}`;
    result.apiDefault = type === 'number' && Number.isFinite(Number(param.default)) ? Number(param.default)
      : type === 'boolean' ? param.default === 'true' : param.default;
  }
  const imageUrl = /^(?:image_urls?|first_frame_image|last_frame_image|end_frame_image|mask_url)$/.test(param.body)
    && (type === 'string' || result.schema?.items?.type === 'string');
  if (imageUrl || /image|mask/i.test(param.body) && /base64/i.test(param.text)
    && !/(?:not support[^.\n]*base64|base64[^.\n]*(?:not supported|unsupported)|does not accept[^.\n]*base64)/i.test(param.text)) {
    result.type = 'files'; result.uploadToApimart = true;
    result.accept = 'image/png,image/jpeg,image/webp,image/gif'; result.maxSizeMb = 20;
    result.scalar = type !== 'json';
    const limit = /(?:up to|maximum(?: of)?)\s*(\d+)\s*(?:reference\s*)?images/i.exec(param.text);
    if (limit) result.maxFiles = Number(limit[1]);
  }
  return result;
}
async function main() {
  const index = await read(`${base}/_llms/en/api-manual.md`);
  const urls = [...new Set([...index.matchAll(/\((https:\/\/docs\.apimart\.ai\/en\/api-reference\/(?:images|videos|audios)\/[^)]+\.md)\)/g)].map(m => m[1]))]
    .filter(url => /\/(?:generation(?:-lite|-official)?|official|i2v-flash-generation|kling-v2-6-motion-control-generation|imagine|max|context-ir|regeneration|music)\.md$/.test(url));
  const models = {};
  const failures = [];
  for (let offset = 0; offset < urls.length; offset += 6) {
    await Promise.all(urls.slice(offset, offset + 6).map(async url => {
      try {
        const markdown = await read(url);
        const extracted = params(markdown);
        const parameters = extracted.length ? extracted : tableParams(markdown);
        const model = parameters.find(p => p.body === 'model');
        const ids = [...new Set([...(model?.text || '').matchAll(/`([a-zA-Z][a-zA-Z0-9._-]+)`/g)].map(m => m[1]))]
          .filter(id => /[-.0-9]/.test(id) || ['suno', 'flowmusic', 'midjourney', 'viduq3'].includes(id));
        if (!ids.length) {
          const example = /"model"\s*:\s*"([a-zA-Z][a-zA-Z0-9._-]+)"/.exec(markdown);
          if (example) ids.push(example[1]);
        }
        if (url.endsWith('/midjourney/imagine.md')) ids.push('midjourney');
        const endpoint = /https:\/\/api\.apimart\.ai(\/v1\/[a-zA-Z0-9/_-]+)/.exec(markdown)?.[1];
        if (!endpoint || !ids.length) return;
        const fields = parameters.filter(p => !['model', 'prompt', 'sound_prompt', 'nsfw_check', 'callback_url', 'webhook_url', 'webhook'].includes(p.body) && !p.body.includes('.')).map(field);
        for (const id of ids) models[id] = { endpoint, source: url.replace(/\.md$/, ''),
          promptRequired: parameters.some(p => ['prompt', 'sound_prompt'].includes(p.body) && p.required), fields };
      } catch (error) { failures.push(`${url}: ${error.message}`); }
    }));
  }
  if (failures.length) throw new Error(failures.join('\n'));
  const filename = path.resolve(__dirname, '../config/apimart-schemas.json');
  await fs.writeFile(filename, JSON.stringify({ models: Object.fromEntries(Object.entries(models).sort(([a], [b]) => a.localeCompare(b))) }, null, 2) + '\n');
  console.log(`Saved ${Object.keys(models).length} model schemas from ${urls.length} documentation pages`);
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { params, field };
