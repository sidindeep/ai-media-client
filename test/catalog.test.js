const test = require('node:test');
const assert = require('node:assert/strict');
const { models } = require('../src/catalog');

test('Seedance 2 exposes only server-valid duration choices to clients', () => {
  const model = models.find(item => item.apiModel === 'bytedance/seedance-2');
  const duration = model.fields.find(field => field.key === 'duration');
  assert.deepEqual(duration.options, [-1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  assert.equal(duration.options.includes(17), false);
});
