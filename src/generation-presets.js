const { randomUUID } = require('node:crypto');

const modes = new Set(['text', 'image', 'video', 'audio']);
const codexRatios = new Set(['auto', '1:1', '16:9', '9:16', '3:2', '2:3']);

function shortString(value, limit, error) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error(error);
  return value.trim();
}

function jsonCopy(value) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { throw new Error('Некорректные параметры пресета'); }
  if (!serialized || serialized.length > 50000) throw new Error('Пресет слишком большой');
  return JSON.parse(serialized);
}

class GenerationPresets {
  constructor(store, findModel) { Object.assign(this, { store, findModel }); }

  async list() { return (await this.store.list()).filter(row => !row.deleted); }

  async save(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Некорректный пресет');
    const existingRows = await this.list();
    const existing = input.id ? existingRows.find(row => row.id === input.id) : null;
    if (input.id && !existing) throw new Error('Пресет не найден');
    if (!input.id && existingRows.length >= 50) throw new Error('Можно сохранить не более 50 пресетов');
    const name = shortString(input.name, 80, 'Введите название пресета до 80 символов');
    const provider = input.provider;
    const mode = input.mode;
    const quantity = Number(input.quantity ?? 1);
    if (!['codex', 'media'].includes(provider) || !modes.has(mode)) throw new Error('Некорректный режим пресета');
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 4) throw new Error('Некорректное количество генераций');

    let settings;
    if (provider === 'media') {
      const model = this.findModel(shortString(input.mediaModelId, 240, 'Выберите модель пресета'));
      if ((model.kind || 'image') !== mode) throw new Error('Модель не соответствует режиму пресета');
      const allowed = new Set((model.fields || []).filter(field => field.type !== 'files' && !/prompt/i.test(field.key)).map(field => field.key));
      const rawInput = input.mediaInput && typeof input.mediaInput === 'object' && !Array.isArray(input.mediaInput) ? input.mediaInput : {};
      const mediaInput = jsonCopy(Object.fromEntries(Object.entries(rawInput).filter(([key]) => allowed.has(key))));
      settings = { mediaModelId: model.id, mediaInput };
    } else {
      if (!['text', 'image'].includes(mode)) throw new Error('Codex поддерживает пресеты текста и изображений');
      const codexModel = shortString(input.codexModel, 120, 'Выберите модель Codex');
      const codexEffort = shortString(input.codexEffort, 30, 'Выберите уровень рассуждения');
      const codexSpeed = input.codexSpeed;
      const codexAspectRatio = input.codexAspectRatio || 'auto';
      if (!['standard', 'fast'].includes(codexSpeed) || !codexRatios.has(codexAspectRatio)) throw new Error('Некорректные параметры Codex');
      settings = { codexModel, codexEffort, codexSpeed, codexAspectRatio };
    }

    return this.store.update(input.id || randomUUID(), {
      name, provider, mode, quantity, ...settings, deleted: false,
      createdAt: existing?.createdAt || new Date().toISOString(),
    });
  }

  async remove(id) {
    const existing = (await this.list()).find(row => row.id === id);
    if (!existing) throw new Error('Пресет не найден');
    await this.store.update(id, { deleted: true });
    return true;
  }
}

module.exports = { GenerationPresets };
