const fs = require('node:fs/promises');
const path = require('node:path');

class History {
  constructor(file) { this.file = file; this.queue = Promise.resolve(); }
  async read() {
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (!Array.isArray(data)) throw new Error('Некорректный файл истории');
      return data;
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async list() { await this.queue; return this.read(); }
  update(id, changes, expectedStates) {
    const operation = this.queue.then(async () => {
      const records = await this.read();
      const index = records.findIndex(item => item.id === id);
      if (expectedStates && !expectedStates.includes(records[index]?.state)) throw new Error('Состояние задачи уже изменилось');
      const previous = index < 0 ? null : records[index];
      const record = { ...(previous || { id }), ...changes, revision: Number(previous?.revision || 0) + 1, updatedAt: new Date().toISOString() };
      if (index < 0) records.unshift(record); else records[index] = record;
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file + '.tmp', JSON.stringify(records, null, 2));
      for (let attempt = 0; ; attempt++) {
        try { await fs.rename(this.file + '.tmp', this.file); break; }
        catch (error) {
          if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 5) throw error;
          await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
        }
      }
      return record;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
module.exports = { History };
