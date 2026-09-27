const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { testPool } = require('./helpers/pg-pool');
const { openDatabase } = require('../src/database/database');
const { createWorkspaces } = require('../src/services/workspaces');

test('database rejects a chat linked to another account project', async t => {
  const pool = await openDatabase({}, testPool());
  t.after(() => pool.end());
  const first = randomUUID(), second = randomUUID(), projectId = randomUUID();
  await pool.query("INSERT INTO media_accounts(id,display_name) VALUES($1,'First'),($2,'Second')", [first, second]);
  await pool.query("INSERT INTO media_projects(id,account_id,owner_id,name) VALUES($1,$2,$2,'Private')", [projectId, first]);
  await assert.rejects(pool.query("INSERT INTO media_chats(id,account_id,project_id,name) VALUES($1,$2,$3,'Foreign')",
    [randomUUID(), second, projectId]), error => error.code === '23503');
});

test('failed chat update rolls back project archive', async t => {
  const pool = await openDatabase({}, testPool());
  t.after(() => pool.end());
  const accountId = randomUUID();
  await pool.query("INSERT INTO media_accounts(id,display_name) VALUES($1,'Workspace')", [accountId]);
  const workspaces = createWorkspaces(pool, { dataDirectory: '/app/data/service' });
  t.after(() => workspaces.close());
  const project = await workspaces.createProject(accountId, 'Active');
  const chat = await workspaces.createChat(accountId, { projectId: project.id });
  const failingPool = { ...pool, async connect() {
    const client = await pool.connect();
    return { release: () => client.release(), query: (sql, params) => {
      if (sql.startsWith('UPDATE media_chats SET archived_at=COALESCE')) throw new Error('Injected chat write failure');
      return client.query(sql, params);
    } };
  } };
  const failing = createWorkspaces(failingPool, { dataDirectory: '/app/data/service' });
  t.after(() => failing.close());
  await assert.rejects(failing.archiveProject(accountId, project.id), /Injected chat write failure/);
  assert.equal((await workspaces.listProjects(accountId))[0].archivedAt, null);
  assert.equal((await workspaces.listChats(accountId, { projectId: project.id }))[0].archivedAt, null);
  await workspaces.archiveProject(accountId, project.id);
  assert.ok((await workspaces.listProjects(accountId, true))[0].archivedAt);
  assert.ok((await workspaces.listChats(accountId, { projectId: project.id, includeArchived: true }))[0].archivedAt);
  await assert.rejects(workspaces.createChat(accountId, { projectId: project.id }), error => error.status === 409);
  await assert.rejects(workspaces.moveChat(accountId, chat.id, project.id), error => error.status === 409);
});
