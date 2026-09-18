const fs = require('node:fs/promises');
const path = require('node:path');
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
function validatePng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33 || buffer.length > MAX_IMAGE_BYTES
    || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || buffer.toString('ascii', 12, 16) !== 'IHDR'
    || buffer.readUInt32BE(16) === 0 || buffer.readUInt32BE(20) === 0) {
    throw new Error('Codex не вернул корректный PNG. Кредиты не списаны.');
  }
  return buffer;
}
async function collectImage(home, threadId) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(threadId || '')) throw new Error('Не получен файл изображения. Кредиты не списаны.');
  const directory = path.join(home, 'generated_images', threadId);
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.png')) continue;
    const filename = path.join(directory, entry.name);
    if ((await fs.stat(filename)).size > MAX_IMAGE_BYTES) continue;
    return { buffer: validatePng(await fs.readFile(filename)), directory };
  }
  throw new Error('Codex не создал изображение. Кредиты не списаны.');
}
module.exports = { validatePng, collectImage, MAX_IMAGE_BYTES };
