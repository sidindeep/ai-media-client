const { createHash, randomBytes } = require('node:crypto');
const { transaction } = require('../database/database');

const digest = value => createHash('sha256').update(value).digest('hex');

function createTelegramLinkService(pool) {
  return {
    async create(accountId) {
      const token = randomBytes(32).toString('base64url');
      await transaction(pool, async client => {
        await client.query('DELETE FROM media_telegram_link_flows WHERE account_id=$1 OR expires_at<=now()', [accountId]);
        await client.query("INSERT INTO media_telegram_link_flows(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '10 minutes')", [digest(token), accountId]);
      });
      return token;
    },
    async complete(token, telegramUserId, username = null) {
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Ссылка привязки недействительна или устарела');
      const telegramId = String(telegramUserId ?? '');
      if (!/^\d{1,20}$/.test(telegramId)) throw new Error('Не удалось подтвердить пользователя Telegram');
      return transaction(pool, async client => {
        const flow = (await client.query('SELECT account_id,telegram_user_id,consumed_at FROM media_telegram_link_flows WHERE token_hash=$1 AND expires_at>now() FOR UPDATE', [digest(token)])).rows[0];
        if (!flow) throw new Error('Ссылка привязки недействительна или устарела. Создайте новую в аккаунте.');
        if (flow.consumed_at) {
          const linked = (await client.query('SELECT account_id FROM media_telegram_links WHERE telegram_user_id=$1', [telegramId])).rows[0];
          if (flow.telegram_user_id === telegramId && linked?.account_id === flow.account_id) return { accountId: flow.account_id };
          throw new Error('Ссылка привязки уже использована. Создайте новую в аккаунте.');
        }
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`telegram:${telegramId}`]);
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`telegram-account:${flow.account_id}`]);
        const existing = (await client.query('SELECT account_id FROM media_telegram_links WHERE telegram_user_id=$1 FOR UPDATE', [telegramId])).rows[0];
        if (existing && existing.account_id !== flow.account_id) throw new Error('Этот Telegram уже привязан к другому аккаунту');
        const accountLink = (await client.query('SELECT telegram_user_id FROM media_telegram_links WHERE account_id=$1 FOR UPDATE', [flow.account_id])).rows[0];
        if (accountLink && accountLink.telegram_user_id !== telegramId) throw new Error('К аккаунту уже привязан другой Telegram. Сначала отвяжите его в настройках.');
        await client.query('INSERT INTO media_telegram_links(telegram_user_id,account_id,username) VALUES($1,$2,$3) ON CONFLICT(telegram_user_id) DO UPDATE SET username=EXCLUDED.username', [telegramId, flow.account_id, typeof username === 'string' ? username.slice(0, 64) : null]);
        await client.query('UPDATE media_telegram_link_flows SET telegram_user_id=$2,consumed_at=now() WHERE token_hash=$1', [digest(token), telegramId]);
        return { accountId: flow.account_id };
      });
    },
    async get(accountId) {
      const row = (await pool.query('SELECT telegram_user_id,username,linked_at FROM media_telegram_links WHERE account_id=$1', [accountId])).rows[0];
      return row ? { linked: true, telegramUserId: row.telegram_user_id, username: row.username, linkedAt: row.linked_at } : { linked: false };
    },
    async unlink(accountId) {
      return transaction(pool, async client => {
        const result = await client.query('DELETE FROM media_telegram_links WHERE account_id=$1 RETURNING telegram_user_id', [accountId]);
        await client.query('DELETE FROM media_telegram_link_flows WHERE account_id=$1', [accountId]);
        await client.query("UPDATE media_records SET data=data-'telegramUserId',updated_at=now() WHERE account_id=$1 AND namespace='history' AND data ? 'telegramUserId'", [accountId]);
        return Boolean(result.rowCount);
      });
    },
    async accountFor(telegramUserId) {
      if (!/^\d{1,20}$/.test(String(telegramUserId ?? ''))) return null;
      return (await pool.query('SELECT a.id,a.role FROM media_telegram_links l JOIN media_accounts a ON a.id=l.account_id WHERE l.telegram_user_id=$1', [String(telegramUserId)])).rows[0] || null;
    },
    async pendingNotifications() {
      const states = ['success', 'fail', 'unknown', 'blocked'];
      return (await pool.query(`SELECT l.telegram_user_id,l.account_id,r.data
        FROM media_telegram_links l JOIN media_records r ON r.account_id=l.account_id AND r.namespace='history'
        WHERE r.data->>'requestId' LIKE ('telegram:' || l.account_id::text || ':%')
          AND r.data->>'telegramUserId'=l.telegram_user_id
          AND r.data->>'state'=ANY($1::text[]) AND COALESCE(r.data->>'telegramNotified','false')<>'true'
        ORDER BY r.updated_at LIMIT 100`, [states])).rows;
    }
  };
}

module.exports = { createTelegramLinkService };
