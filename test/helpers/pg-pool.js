const { PGlite } = require('@electric-sql/pglite');
// Real PostgreSQL SQL engine, serialized single-connection pool for deterministic tests.
function testPool() {
  const db = new PGlite();
  let chain = Promise.resolve();
  const query = async (sql, params) => {
    const text = typeof sql === 'string' ? sql : sql.text;
    if (text.includes("current_setting('max_connections')")) return { rows: [{ max_connections: '100', sessions: '1', role_connection_limit: '-1', role_sessions: '1' }], rowCount: 1 };
    if (!params && text.includes(';')) { await db.exec(text); return { rows: [], rowCount: 0 }; }
    const result = await db.query(text, params);
    return { rows: result.rows, rowCount: result.rows.length || result.affectedRows || 0 };
  };
  const connect = async () => {
    const previous = chain; let release;
    chain = new Promise(resolve => { release = resolve; }); await previous;
    return { query, release };
  };
  return { connect, async query(sql, params) { const client = await connect(); try { return await query(sql, params); } finally { client.release(); } }, async end() { await chain; await db.close(); } };
}
module.exports = { testPool };
