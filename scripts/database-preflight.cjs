const { Pool } = require('pg');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL не задан');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const queries = {
      crossAccountChatProjects: `SELECT count(*)::int AS count FROM media_chats c JOIN media_projects p ON p.id=c.project_id WHERE c.account_id<>p.account_id`,
      duplicateActiveSystemChats: `SELECT count(*)::int AS count FROM (
        SELECT account_id,project_id FROM media_chats WHERE mode='system' AND archived_at IS NULL
        GROUP BY account_id,project_id HAVING count(*)>1) duplicates`,
      nonObjectRecords: `SELECT count(*)::int AS count FROM media_records WHERE jsonb_typeof(data)<>'object'`,
      danglingChatReferences: `SELECT count(*)::int AS count FROM media_records r WHERE r.data->>'chatId' ~ '^[a-f0-9-]{36}$'
        AND NOT EXISTS (SELECT 1 FROM media_chats c WHERE c.account_id=r.account_id AND c.id::text=r.data->>'chatId')`,
      danglingProjectReferences: `SELECT count(*)::int AS count FROM media_records r WHERE r.data->>'projectId' ~ '^[a-f0-9-]{36}$'
        AND NOT EXISTS (SELECT 1 FROM media_projects p WHERE p.account_id=r.account_id AND p.id::text=r.data->>'projectId')`,
    };
    const result = {};
    for (const [name, sql] of Object.entries(queries)) result[name] = (await pool.query(sql)).rows[0].count;
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } finally { await pool.end(); }
}
main().catch(error => { process.stderr.write(`${error.code || error.message}\n`); process.exitCode = 1; });
