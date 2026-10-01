const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { testPool } = require('./helpers/pg-pool');
const { openDatabase } = require('../src/database/database');
const { createWorkspaces } = require('../src/services/workspaces');
const { createMovieDrafts } = require('../src/services/movie-drafts');

test('movie drafts persist per account/project, validate owners and reject stale writes', async t => {
  const pool = await openDatabase({}, testPool()); t.after(() => pool.end());
  const owner = randomUUID(), other = randomUUID(), asset = randomUUID();
  for (const id of [owner, other]) await pool.query("INSERT INTO media_accounts(id,display_name) VALUES($1,'Movie')", [id]);
  const workspaces = createWorkspaces(pool, { dataDirectory: '.' });
  const project = await workspaces.createProject(owner, 'Movie');
  const links = [];
  const content = { file: async (id, file) => {
    if (id !== owner || file !== asset) throw Object.assign(new Error('Файл не найден'), { status: 404 });
    return { type: 'image/png' };
  }, link: async (...args) => links.push(args) };
  const drafts = createMovieDrafts({ pool, workspaces, content });
  const draft = { scenes: [{ id: randomUUID(), kind: 'image', title: '', seconds: 5, src: `/api/content/${asset}`, name: 'photo.png' }],
    format: 'portrait', background: '#151522', muteClips: false, music: '', musicName: '', script: 'Сценарий', sourceLink: '' };
  const saved = await drafts.save(owner, project.id, { draft, revision: 0 });
  assert.equal(saved.revision, 1); assert.equal(links.length, 1);
  assert.equal((await drafts.read(owner, project.id)).script, 'Сценарий');
  assert.equal(await drafts.read(owner, null), null);
  assert.equal(await drafts.read(other, null), null);
  await assert.rejects(drafts.read(other, project.id), { status: 404 });
  await assert.rejects(drafts.save(owner, project.id, { draft, revision: 0 }), { status: 409 });
  const second = await drafts.save(owner, project.id, { draft: { ...draft, script: 'Изменён' }, revision: 1 });
  assert.equal(second.revision, 2);
  await assert.rejects(drafts.save(other, null, { draft, revision: 0 }), { status: 404 });
  for (const src of ['blob:temporary', 'https://external.example/photo.png', '/api/content/' + randomUUID()])
    await assert.rejects(drafts.save(owner, null, { draft: { ...draft, scenes: [{ ...draft.scenes[0], src }] }, revision: 0 }));
  const resumed = createMovieDrafts({ pool, workspaces, content });
  assert.deepEqual((await resumed.read(owner, project.id)).scenes, saved.scenes);
});
