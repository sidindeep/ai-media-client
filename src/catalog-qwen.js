// Corrections to Kie's public OpenAPI: the text-to-image page incorrectly
// repeats the image-edit model enum. Keep both documented operations distinct.
function applyQwenCorrections(models) {
  const text = models.find(model => model.apiModel === 'qwen2/image-edit');
  if (text && !models.some(model => model.apiModel === 'qwen2/text-to-image')) {
    const generation = structuredClone(text);
    Object.assign(generation, { id: 'kie:qwen2/text-to-image', apiModel: 'qwen2/text-to-image',
      name: 'Qwen2 Text To Image', description: 'Генерация изображения по тексту' });
    models.push(generation);
  }
  if (text) {
    Object.assign(text, { name: 'Qwen2 Image Edit', description: 'Редактирование исходного изображения',
      source: 'https://docs.kie.ai/market/qwen2/image-edit.md' });
    text.inputSchema.properties.image_url = { type: 'string', format: 'uri', description: 'Source image URL' };
    text.inputSchema.properties.image_size.enum = ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9'];
    text.inputSchema.required = [...new Set([...(text.inputSchema.required || []), 'prompt', 'image_url'])];
    text.fields.find(field => field.key === 'image_size').options = text.inputSchema.properties.image_size.enum;
    text.fields.find(field => field.key === 'image_size').schema = text.inputSchema.properties.image_size;
    if (!text.fields.some(field => field.key === 'image_url')) text.fields.push({ key: 'image_url',
      label: 'Исходное изображение', type: 'files', required: true, scalar: true, maxFiles: 1,
      maxSizeMb: 10, accept: 'image/jpeg,image/png,image/webp', schema: text.inputSchema.properties.image_url });
  }
  for (const editing of [false, true]) {
    const apiModel = `qwen2-1/${editing ? 'image-to-image' : 'text-to-image'}`;
    if (models.some(model => model.apiModel === apiModel)) continue;
    const properties = {
      prompt: { type: 'string', minLength: 1, maxLength: 5000 },
      aspect_ratio: { type: 'string', enum: [...(editing ? ['auto'] : []), '1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16', '21:9', '9:21'], default: editing ? 'auto' : '1:1' },
      resolution: { type: 'string', enum: ['1K', '2K'], default: '1K' },
      background: { type: 'string', enum: ['opaque', 'transparent'], default: 'opaque' },
      output_format: { type: 'string', enum: ['png', 'webp', 'jpeg'], default: 'png' },
      enhance_prompt: { type: 'boolean', default: true }, seed: { type: 'integer' }, nsfw_checker: { type: 'boolean' },
    };
    if (editing) Object.assign(properties, {
      image_urls: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string', format: 'uri' } },
      mask_url: { type: 'string', format: 'uri' },
    });
    const required = editing ? ['image_urls', 'prompt'] : ['prompt'];
    const fields = Object.entries(properties).map(([key, schema]) => ({ key, label: key, schema,
      required: required.includes(key), type: schema.enum ? 'select' : schema.type === 'boolean' ? 'boolean'
        : schema.type === 'integer' ? 'number' : 'textarea', ...(schema.enum ? { options: schema.enum } : {}),
      ...(schema.default !== undefined ? { default: schema.default } : {}) }));
    models.push({ id: `kie:${apiModel}`, apiModel, providerId: 'kie', kind: 'image',
      name: `Qwen2.1 ${editing ? 'Image To Image' : 'Text To Image'}`, description: 'Qwen 2.1',
      source: `https://docs.kie.ai/market/${apiModel}.md`, inputSchema: { type: 'object', properties, required },
      fields, pricing: { type: 'reported', label: 'Стоимость зависит от разрешения' } });
  }
}
module.exports = { applyQwenCorrections };
