function identifier(value) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value || '')) throw new Error('Некорректное имя роли PostgreSQL');
  return `"${value}"`;
}
const quoted = value => `"${String(value).replace(/"/g, '""')}"`;

async function grantRuntimeRole(pool, roleName) {
  const role = identifier(roleName);
  const database = (await pool.query('SELECT current_database() AS name')).rows[0].name;
  await pool.query(`GRANT CONNECT ON DATABASE ${quoted(database)} TO ${role}`);
  await pool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  const tables = (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows.map(row => row.tablename);
  for (const table of tables) {
    const privileges = ['media_schema_versions', 'media_schema_migrations'].includes(table)
      ? 'SELECT' : 'SELECT,INSERT,UPDATE,DELETE';
    await pool.query(`GRANT ${privileges} ON TABLE public.${quoted(table)} TO ${role}`);
  }
  await pool.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
}

module.exports = { grantRuntimeRole };
