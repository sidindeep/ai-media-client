const { randomUUID } = require('node:crypto');
const { transaction } = require('../database/database');

function bad(message, status = 400) { return Object.assign(new Error(message), { status }); }
function cleanName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) throw bad('Укажите название до 200 символов');
  return value.trim();
}
function id(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value)) throw bad(`${label} не найден`, 404);
  return value;
}
function project(row) {
  return { id: row.id, accountId: row.account_id, ownerId: row.owner_id, name: row.name,
    archivedAt: row.archived_at?.toISOString?.() || row.archived_at || null,
    createdAt: row.created_at?.toISOString?.() || row.created_at,
    updatedAt: row.updated_at?.toISOString?.() || row.updated_at,
    chatCount: Number(row.chat_count || 0), materialCount: Number(row.material_count || 0) };
}
function chat(row) {
  return { id: row.id, accountId: row.account_id, projectId: row.project_id, name: row.name,
    mode: row.mode, context: row.context || {}, archivedAt: row.archived_at?.toISOString?.() || row.archived_at || null,
    createdAt: row.created_at?.toISOString?.() || row.created_at,
    updatedAt: row.updated_at?.toISOString?.() || row.updated_at,
    materialCount: Number(row.material_count || 0) };
}
function publicMaterial(record, namespace) {
  const fields = ['id', 'requestId', 'revision', 'state', 'createdAt', 'updatedAt', 'modelId', 'modelName', 'kind', 'input', 'sourceFiles', 'projectId', 'chatId',
    'queuedAt', 'preparingAt', 'submittingAt', 'providerAcceptedAt', 'providerFirstCheckedAt', 'providerStateChangedAt', 'lastCheckedAt', 'resultReceivedAt', 'resultSavedAt',
    'progress', 'providerDurationMs', 'generationStartedAt', 'generationCompletedAt', 'generationDurationMs', 'output', 'error', 'localFiles', 'usage'];
  return { namespace, ...Object.fromEntries(fields.filter(key => record[key] !== undefined).map(key => [key, record[key]])) };
}

async function ensureDefaultChatRow(client, accountId, projectId = null) {
  await client.query('SELECT id FROM media_accounts WHERE id=$1 FOR UPDATE', [accountId]);
  const existing = (await client.query(`SELECT id FROM media_chats
    WHERE account_id=$1 AND project_id IS NOT DISTINCT FROM $2::uuid AND mode='system' AND archived_at IS NULL
    ORDER BY created_at,id LIMIT 1`, [accountId, projectId])).rows[0];
  if (existing) return existing.id;
  const chatId = randomUUID();
  await client.query(`INSERT INTO media_chats(id,account_id,project_id,name,mode)
    VALUES($1,$2,$3,'Основной чат','system')`, [chatId, accountId, projectId]);
  return chatId;
}

function createWorkspaces(pool) {
  async function projectRow(accountId, projectId, lock = false) {
    const result = await pool.query(`SELECT p.*, count(DISTINCT c.id)::int AS chat_count,
      (SELECT count(*) FROM media_records r WHERE r.account_id=p.account_id AND r.data->>'projectId'=p.id::text)::int AS material_count
      FROM media_projects p LEFT JOIN media_chats c ON c.project_id=p.id AND c.archived_at IS NULL
      WHERE p.account_id=$1 AND p.id=$2 GROUP BY p.id`, [accountId, projectId]);
    if (!result.rows[0]) throw bad('Проект не найден', 404);
    if (lock) await pool.query('SELECT id FROM media_projects WHERE account_id=$1 AND id=$2 FOR UPDATE', [accountId, projectId]);
    return result.rows[0];
  }
  async function chatRow(accountId, chatId) {
    const result = await pool.query(`SELECT c.*,
      (SELECT count(*) FROM media_records r WHERE r.account_id=c.account_id AND r.data->>'chatId'=c.id::text)::int AS material_count
      FROM media_chats c WHERE c.account_id=$1 AND c.id=$2`, [accountId, chatId]);
    if (!result.rows[0]) throw bad('Чат не найден', 404);
    return result.rows[0];
  }
  async function assertBinding(accountId, projectId, chatId) {
    let resolvedProjectId = projectId || null;
    if (resolvedProjectId !== null) {
      const row = await projectRow(accountId, id(resolvedProjectId, 'Проект'));
      if (row.archived_at) throw bad('Архивный проект недоступен для новых генераций', 409);
    }
    if (chatId !== undefined && chatId !== null) {
      const row = await chatRow(accountId, id(chatId, 'Чат'));
      if (resolvedProjectId && row.project_id !== resolvedProjectId) throw bad('Чат не принадлежит выбранному проекту', 409);
      resolvedProjectId = resolvedProjectId || row.project_id;
      if (row.archived_at) throw bad('Архивный чат недоступен для новых генераций', 409);
    } else {
      chatId = await transaction(pool, client => ensureDefaultChatRow(client, accountId, resolvedProjectId));
    }
    return { projectId: resolvedProjectId, chatId };
  }
  return {
    async ensureDefaultChat(accountId, projectId = null) {
      const chatId = await transaction(pool, client => ensureDefaultChatRow(client, accountId, projectId));
      return chat(await chatRow(accountId, chatId));
    },
    async listProjects(accountId, includeArchived = false) {
      const filter = includeArchived ? '' : ' AND p.archived_at IS NULL';
      const result = await pool.query(`SELECT p.*, count(DISTINCT c.id)::int AS chat_count,
        (SELECT count(*) FROM media_records r WHERE r.account_id=p.account_id AND r.data->>'projectId'=p.id::text)::int AS material_count
        FROM media_projects p LEFT JOIN media_chats c ON c.project_id=p.id AND c.archived_at IS NULL
        WHERE p.account_id=$1${filter} GROUP BY p.id ORDER BY p.archived_at NULLS FIRST,p.updated_at DESC,p.id`, [accountId]);
      return result.rows.map(project);
    },
    async listProjectChanges(accountId, since, before) {
      const result = await pool.query(`SELECT p.*, count(DISTINCT c.id)::int AS chat_count,
        (SELECT count(*) FROM media_records r WHERE r.account_id=p.account_id AND r.data->>'projectId'=p.id::text)::int AS material_count
        FROM media_projects p LEFT JOIN media_chats c ON c.project_id=p.id AND c.archived_at IS NULL
        WHERE p.account_id=$1 AND p.updated_at>$2::timestamptz AND p.updated_at<=$3::timestamptz
        GROUP BY p.id ORDER BY p.updated_at DESC,p.id`, [accountId, since, before]);
      return result.rows.map(project);
    },
    async createProject(accountId, name) {
      const value = cleanName(name), projectId = randomUUID();
      await pool.query('INSERT INTO media_projects(id,account_id,owner_id,name) VALUES($1,$2,$2,$3)', [projectId, accountId, value]);
      return project(await projectRow(accountId, projectId));
    },
    async renameProject(accountId, projectId, name) {
      const value = cleanName(name), pid = id(projectId, 'Проект');
      await projectRow(accountId, pid);
      await pool.query('UPDATE media_projects SET name=$3,updated_at=now() WHERE account_id=$1 AND id=$2', [accountId, pid, value]);
      return project(await projectRow(accountId, pid));
    },
    async archiveProject(accountId, projectId) {
      const pid = id(projectId, 'Проект');
      await projectRow(accountId, pid);
      await pool.query('UPDATE media_projects SET archived_at=COALESCE(archived_at,now()),updated_at=now() WHERE account_id=$1 AND id=$2', [accountId, pid]);
      await pool.query('UPDATE media_chats SET archived_at=COALESCE(archived_at,now()),updated_at=now() WHERE account_id=$1 AND project_id=$2', [accountId, pid]);
      return project(await projectRow(accountId, pid));
    },
    async listChats(accountId, { projectId, includeArchived = false } = {}) {
      const params = [accountId], filters = ['c.account_id=$1'];
      if (projectId === null) filters.push('c.project_id IS NULL');
      else if (projectId !== undefined) { params.push(id(projectId, 'Проект')); filters.push(`c.project_id = $${params.length}`); }
      if (!includeArchived) filters.push('c.archived_at IS NULL');
      const result = await pool.query(`SELECT c.*,
        (SELECT count(*) FROM media_records r WHERE r.account_id=c.account_id AND r.data->>'chatId'=c.id::text)::int AS material_count
        FROM media_chats c WHERE ${filters.join(' AND ')} ORDER BY c.archived_at NULLS FIRST,c.updated_at DESC,c.id`, params);
      return result.rows.map(chat);
    },
    async listChatChanges(accountId, since, before) {
      const result = await pool.query(`SELECT c.*,
        (SELECT count(*) FROM media_records r WHERE r.account_id=c.account_id AND r.data->>'chatId'=c.id::text)::int AS material_count
        FROM media_chats c WHERE c.account_id=$1 AND c.updated_at>$2::timestamptz AND c.updated_at<=$3::timestamptz
        ORDER BY c.updated_at DESC,c.id`, [accountId, since, before]);
      return result.rows.map(chat);
    },
    async createChat(accountId, { name, projectId = null, context = {} } = {}) {
      const value = cleanName(name || 'Новый чат'), pid = projectId === null ? null : id(projectId, 'Проект');
      if (pid) { const row = await projectRow(accountId, pid); if (row.archived_at) throw bad('Нельзя создать чат в архивном проекте', 409); }
      const chatId = randomUUID();
      await pool.query('INSERT INTO media_chats(id,account_id,project_id,name,context) VALUES($1,$2,$3,$4,$5)', [chatId, accountId, pid, value, JSON.stringify(context && typeof context === 'object' ? context : {})]);
      return chat(await chatRow(accountId, chatId));
    },
    async renameChat(accountId, chatId, name) {
      const cid = id(chatId, 'Чат'); await chatRow(accountId, cid);
      await pool.query('UPDATE media_chats SET name=$3,updated_at=now() WHERE account_id=$1 AND id=$2', [accountId, cid, cleanName(name)]);
      return chat(await chatRow(accountId, cid));
    },
    async moveChat(accountId, chatId, projectId = null) {
      const cid = id(chatId, 'Чат'), pid = projectId === null ? null : id(projectId, 'Проект');
      await chatRow(accountId, cid);
      if (pid) { const row = await projectRow(accountId, pid); if (row.archived_at) throw bad('Нельзя перенести чат в архивный проект', 409); }
      await pool.query('UPDATE media_chats SET project_id=$3,updated_at=now() WHERE account_id=$1 AND id=$2', [accountId, cid, pid]);
      return chat(await chatRow(accountId, cid));
    },
    async archiveChat(accountId, chatId) {
      const cid = id(chatId, 'Чат'), current = await chatRow(accountId, cid);
      await pool.query('UPDATE media_chats SET archived_at=COALESCE(archived_at,now()),updated_at=now() WHERE account_id=$1 AND id=$2', [accountId, cid]);
      if (current.mode === 'system' && !current.project_id) await transaction(pool, client => ensureDefaultChatRow(client, accountId));
      return chat(await chatRow(accountId, cid));
    },
    async getChat(accountId, chatId) {
      const row = await chatRow(accountId, id(chatId, 'Чат'));
      const records = (await pool.query(`SELECT namespace,data FROM media_records WHERE account_id=$1 AND data->>'chatId'=$2 ORDER BY updated_at DESC,id LIMIT 200`, [accountId, chatId])).rows;
      return { ...chat(row), records: records.map(item => publicMaterial(item.data, item.namespace)) };
    },
    assertBinding,
    async close() {}
  };
}
module.exports = { createWorkspaces, ensureDefaultChatRow };
