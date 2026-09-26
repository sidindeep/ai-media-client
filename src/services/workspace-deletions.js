const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { transaction } = require('../database/database');
const { lockWallet } = require('../billing/wallet');

const UUID = /^[a-f0-9-]{36}$/i;
const FINISHED = new Set(['success', 'fail', 'blocked', 'cancelled', 'canceled']);
const bad = (message, status) => Object.assign(new Error(message), { status });

function createWorkspaceDeletions(pool, { storage, dataDirectory }) {
  const root = path.resolve(dataDirectory);
  let running = false;
  let closed = false;
  const isOwnedObject = (accountId, key) => typeof key === 'string'
    && (new RegExp(`^accounts/${accountId}/(?:content/[a-f0-9-]{36}|codex-images/[a-f0-9-]{36}\\.png|results/[a-f0-9-]{36}/[^/]+)$`, 'i')).test(key);
  const localPath = (accountId, filename) => {
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) return null;
    const relative = path.relative(root, path.resolve(filename)).replace(/\\/g, '/');
    return new RegExp(`^(?:accounts/${accountId}/results/[a-f0-9-]{36}/[^/]+|codex-images/${accountId}/[a-f0-9-]{36}\\.png)$`, 'i').test(relative) ? relative : null;
  };
  const queueFile = async (client, accountId, kind, locator) => {
    if (!locator) return;
    await client.query(`INSERT INTO media_file_deletions(id,account_id,kind,locator)
      VALUES($1,$2,$3,$4) ON CONFLICT(account_id,kind,locator) DO NOTHING`, [randomUUID(), accountId, kind, locator]);
  };

  async function deleteChat(accountId, chatId) {
    if (!UUID.test(String(chatId))) throw bad('Чат не найден', 404);
    const result = await transaction(pool, async client => {
      await lockWallet(client, accountId);
      const chat = (await client.query('SELECT id,archived_at FROM media_chats WHERE account_id=$1 AND id=$2 FOR UPDATE', [accountId, chatId])).rows[0];
      if (!chat) throw bad('Чат не найден', 404);
      if (!chat.archived_at) throw bad('Удалить можно только архивный чат', 409);
      const records = (await client.query(`SELECT namespace,id,data FROM media_records
        WHERE account_id=$1 AND namespace IN ('history','codex','routerai') AND data->>'chatId'=$2 FOR UPDATE`, [accountId, chatId])).rows;
      if (records.some(record => !FINISHED.has(record.data.state))) throw bad('Дождитесь завершения или сверки всех задач чата', 409);
      const linked = (await client.query(`SELECT DISTINCT l.asset_id FROM content_links l
        JOIN media_records r ON r.account_id=l.account_id AND r.namespace=l.namespace AND r.id=l.record_id
        WHERE r.account_id=$1 AND r.namespace IN ('history','codex','routerai') AND r.data->>'chatId'=$2`, [accountId, chatId])).rows;
      const owned = (await client.query("SELECT id FROM content_assets WHERE account_id=$1 AND origin->>'recordId'=ANY($2::text[])",
        [accountId, records.map(record => record.id)])).rows;
      await client.query(`INSERT INTO media_deleted_chat_records(account_id,namespace,id,chat_id)
        SELECT account_id,namespace,id,$2::uuid FROM media_records
        WHERE account_id=$1 AND namespace IN ('history','codex','routerai') AND data->>'chatId'=$2::text
        ON CONFLICT(account_id,namespace,id) DO NOTHING`, [accountId, chatId]);
      const assetIds = new Set([...linked, ...owned].map(row => row.asset_id || row.id));
      for (const record of records) {
        const data = record.data;
        if (UUID.test(String(data.contentAssetId || ''))) assetIds.add(data.contentAssetId);
        for (const file of Array.isArray(data.localFiles) ? data.localFiles : []) {
          if (!file || typeof file !== 'object') continue;
          if (UUID.test(String(file.assetId || ''))) assetIds.add(file.assetId);
          if (isOwnedObject(accountId, file.storageKey)) await queueFile(client, accountId, 'object', file.storageKey);
          await queueFile(client, accountId, 'local', localPath(accountId, file.path));
        }
        if (record.namespace === 'codex' && data.kind === 'image' && UUID.test(String(data.requestId || ''))) {
          if (storage) await queueFile(client, accountId, 'object', `accounts/${accountId}/codex-images/${data.requestId}.png`);
          await queueFile(client, accountId, 'local', `codex-images/${accountId}/${data.requestId}.png`);
        }
      }
      await client.query(`DELETE FROM media_records WHERE account_id=$1
        AND namespace IN ('history','codex','routerai') AND data->>'chatId'=$2`, [accountId, chatId]);
      await client.query("DELETE FROM media_records WHERE account_id=$1 AND namespace='drafts' AND id=$2", [accountId, `chat:${chatId}`]);
      if (assetIds.size) {
        const orphans = (await client.query(`SELECT a.id,a.storage_key,a.status FROM content_assets a
          WHERE a.account_id=$1 AND a.id=ANY($2::uuid[])
          AND NOT EXISTS (SELECT 1 FROM content_links l WHERE l.account_id=a.account_id AND l.asset_id=a.id)
          FOR UPDATE`, [accountId, [...assetIds]])).rows;
        if (orphans.some(asset => asset.status === 'saving')) throw bad('Дождитесь сохранения файлов чата', 409);
        for (const asset of orphans) {
          await client.query('DELETE FROM content_assets WHERE account_id=$1 AND id=$2', [accountId, asset.id]);
          if (isOwnedObject(accountId, asset.storage_key)) await queueFile(client, accountId, 'object', asset.storage_key);
          await queueFile(client, accountId, 'local', `content-staging/${asset.id}.stage`);
        }
      }
      await client.query('DELETE FROM media_chats WHERE account_id=$1 AND id=$2', [accountId, chatId]);
      return { id: chatId, deletedRecords: records.length };
    });
    void drain();
    return result;
  }

  async function drain() {
    if (running || closed) return;
    running = true;
    try {
      const rows = (await pool.query(`SELECT id,account_id,kind,locator,attempts FROM media_file_deletions
        WHERE next_attempt_at<=now() ORDER BY created_at LIMIT 50`)).rows;
      for (const row of rows) {
        try {
          if (row.kind === 'object') {
            if (!storage || !isOwnedObject(row.account_id, row.locator)) throw new Error('Хранилище недоступно');
            await storage.remove(row.locator);
          } else {
            const valid = localPath(row.account_id, path.join(root, row.locator));
            if (valid !== row.locator && !/^content-staging\/[a-f0-9-]{36}\.stage$/i.test(row.locator)) throw new Error('Недопустимый локальный путь');
            await fs.rm(path.join(root, row.locator), { force: true });
          }
          await pool.query('DELETE FROM media_file_deletions WHERE id=$1', [row.id]);
        } catch {
          await pool.query(`UPDATE media_file_deletions SET attempts=attempts+1,
            next_attempt_at=now()+LEAST(attempts+1,60)*interval '1 minute' WHERE id=$1`, [row.id]).catch(() => {});
        }
      }
    } catch { /* Cleanup stays queued until the database is available again. */ }
    finally { running = false; }
  }
  const timer = setInterval(() => { void drain(); }, 60000);
  timer.unref?.();
  setTimeout(() => { void drain(); }, 0).unref?.();
  return { deleteChat, async close() { closed = true; clearInterval(timer); while (running) await new Promise(resolve => setTimeout(resolve, 10)); } };
}

module.exports = { createWorkspaceDeletions };
