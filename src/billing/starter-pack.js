const { randomUUID } = require('node:crypto');
const { SCALE, units } = require('./pricing');

function normalizeStarterPack(config = {}) {
  const enabled = config.enabled !== false;
  const version = String(config.version || '').trim();
  const credits = Number(config.credits);
  const amountUnits = credits * SCALE;
  const allowedProviders = Array.isArray(config.allowedProviders) ? [...new Set(config.allowedProviders.map(String))] : [];
  const unlockLedgerKind = String(config.unlockLedgerKind || 'purchase');
  if (!version || version.length > 60 || !Number.isSafeInteger(amountUnits) || amountUnits <= 0) throw new Error('Некорректная конфигурация стартового пакета');
  if (!allowedProviders.length || allowedProviders.some(provider => !/^[a-z][a-z0-9_-]{1,30}$/.test(provider))) throw new Error('Некорректный список моделей стартового пакета');
  if (unlockLedgerKind !== 'purchase') throw new Error('Стартовый пакет должен открываться только платёжной проводкой purchase');
  return { enabled, version, credits, amountUnits: units(amountUnits), allowedProviders, unlockLedgerKind };
}

function createStarterPack({ pool, config }) {
  const settings = normalizeStarterPack(config);
  const reference = `starter-pack-${settings.version}`;
  if (reference.length > 100) throw new Error('Слишком длинная версия стартового пакета');

  function summarize(role, enrolled, paid) {
    const active = settings.enabled && role !== 'admin' && Boolean(enrolled) && !paid;
    return {
      enabled: settings.enabled,
      enrolled: Boolean(enrolled),
      active,
      unlockedByPayment: Boolean(paid),
      credits: settings.credits,
      modelAccess: active ? 'gpt-only' : 'all',
    };
  }

  async function flags(executor, accountId) {
    const row = (await executor.query(`SELECT
      EXISTS(SELECT 1 FROM media_ledger WHERE account_id=$1 AND kind='grant' AND reference=$2) AS enrolled,
      EXISTS(SELECT 1 FROM media_ledger WHERE account_id=$1 AND kind=$3) AS paid`,
    [accountId, reference, settings.unlockLedgerKind])).rows[0] || {};
    return { enrolled: Boolean(row.enrolled), paid: Boolean(row.paid) };
  }

  async function status(accountId, role = 'user', executor = pool) {
    const value = await flags(executor, accountId);
    return summarize(role, value.enrolled, value.paid);
  }

  return {
    reference,
    settings: () => ({ ...settings, allowedProviders: [...settings.allowedProviders] }),
    summarize,
    async enroll(client, accountId, role = 'user') {
      const amount = settings.enabled && role !== 'admin' ? settings.amountUnits : 0;
      const inserted = await client.query('INSERT INTO media_wallets(account_id,balance) VALUES($1,$2) ON CONFLICT(account_id) DO NOTHING RETURNING account_id', [accountId, amount]);
      if (!inserted.rowCount || !amount) return false;
      await client.query('INSERT INTO media_ledger(id,account_id,kind,reference,amount,note) VALUES($1,$2,\'grant\',$3,$4,$5)',
        [randomUUID(), accountId, reference, amount, `Стартовый пакет: ${settings.credits} кредитов`]);
      return true;
    },
    status,
    async assertProvider(accountId, role, providerId, executor = pool) {
      const access = await status(accountId, role, executor);
      if (access.active && !settings.allowedProviders.includes(providerId)) {
        throw Object.assign(new Error('Медиа-модели откроются после первой оплаты.'), { status: 403, code: 'STARTER_PACK_RESTRICTED' });
      }
      return access;
    },
  };
}

module.exports = { createStarterPack, normalizeStarterPack };
