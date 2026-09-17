const path = require('node:path');

// Enforce the user's single-distribution rule even with a CLI output override.
module.exports = function singleDistribution(context) {
  const expected = path.resolve(__dirname, '../dist/queue-header');
  const actual = path.resolve(context.outDir);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`Для этого проекта разрешён только каталог сборки ${expected}. Получен ${actual}. Не отключайте эту проверку без отмены правила пользователем.`);
  }
};
