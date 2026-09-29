const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { openDatabase } = require('../src/database/database');
const { buildSeedDocument, ensureCurrentParameterConversionConfig,
  activateParameterConversionConfig } = require('../src/services/parameter-conversion-configs');

function poolWithCurrent(active) {
  const rows = new Map([[active, { id: active, isCurrent: true }]]);
  const client = { release() {}, async query(sql, parameters = []) {
    if (sql.startsWith('SELECT id FROM media_parameter_conversion_configs WHERE is_current'))
      return { rows: [...rows.values()].filter(row => row.isCurrent).map(row => ({ id: row.id })) };
    if (sql.startsWith('INSERT INTO media_parameter_conversion_configs')) {
      rows.set(parameters[0], rows.get(parameters[0]) || { id: parameters[0], document: JSON.parse(parameters[2]), isCurrent: false });
    }
    if (sql.startsWith('UPDATE media_parameter_conversion_configs SET is_current=false'))
      for (const row of rows.values()) row.isCurrent = false;
    if (sql.includes('SET is_current=true')) rows.get(parameters[0]).isCurrent = true;
    return { rows: [] };
  } };
  return { rows, connect: async () => client };
}

test('new built-in conversion version replaces the previous built-in version', async () => {
  const pool = poolWithCurrent('routes-2026-09-29-2');
  await ensureCurrentParameterConversionConfig(pool);
  const current = [...pool.rows.values()].find(row => row.isCurrent);
  assert.equal(current.id, 'routes-2026-09-29-3');
  assert.equal(Object.keys(current.document.providers.kie).length, 176);
  assert.ok(current.document.pairs.some(pair => pair.kie === 'kie:veo3_lite:TEXT_2_VIDEO'));
});

test('new built-in conversion version preserves a custom active configuration', async () => {
  const pool = poolWithCurrent('routes-user-config');
  await ensureCurrentParameterConversionConfig(pool);
  assert.equal([...pool.rows.values()].find(row => row.isCurrent).id, 'routes-user-config');
  assert.ok(pool.rows.has('routes-2026-09-29-3'));
});

test('parameter conversion setup and activation do not wait for executor ownership',
  { skip: !process.env.TEST_DATABASE_URL }, async () => {
    const ownerPool = await openDatabase({}, new Pool({ connectionString: process.env.TEST_DATABASE_URL }));
    const owner = await ownerPool.connect();
    const configPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1,
      onConnect: client => client.query('SET statement_timeout = 1000') });
    try {
      await owner.query('SELECT pg_advisory_lock(18274693)');
      const id = await ensureCurrentParameterConversionConfig(configPool);
      assert.ok(id.startsWith('routes-'));
      await activateParameterConversionConfig(configPool, id);
    } finally {
      await owner.query('SELECT pg_advisory_unlock(18274693)').catch(() => {});
      owner.release();
      await Promise.all([configPool.end(), ownerPool.end()]);
    }
  });

test('shared media roles map by provider capability across paired models', () => {
  const document = buildSeedDocument();
  for (const id of ['kie:bytedance/seedance-2', 'kie:bytedance/seedance-2-fast',
    'kie:bytedance/seedance-2-mini', 'kie:bytedance/seedance-2-5']) {
    const pair = document.pairs.find(item => item.kie === id);
    assert.equal(pair.mapping.fields.reference_image_urls, 'image_urls', id);
    assert.deepEqual(pair.mapping.transforms.first_frame_url, { type: 'image_role', role: 'first_frame' }, id);
    assert.deepEqual(pair.mapping.transforms.last_frame_url, { type: 'image_role', role: 'last_frame' }, id);
  }
  assert.equal(document.pairs.find(item => item.kie === 'kie:flux-kontext-pro').mapping.fields.inputImage, 'image_urls');
  assert.equal(document.pairs.find(item => item.kie === 'kie:veo3_fast:REFERENCE_2_VIDEO').mapping.fields.imageUrls, 'image_urls');
});
