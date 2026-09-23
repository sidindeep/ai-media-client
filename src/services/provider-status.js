function balanceAmount(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value))) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function codexWindows(payload) {
  const buckets = payload?.rateLimitsByLimitId && typeof payload.rateLimitsByLimitId === 'object'
    ? Object.values(payload.rateLimitsByLimitId) : payload?.rateLimits ? [payload.rateLimits] : [];
  return buckets.flatMap(bucket => ['primary', 'secondary'].flatMap(window => {
    const value = bucket?.[window];
    if (!value || !Number.isFinite(value.usedPercent)) return [];
    return [{ name: bucket.limitName || bucket.limitId || 'Codex', windowMinutes: value.windowDurationMins ?? null,
      remainingPercent: Math.max(0, Math.min(100, 100 - value.usedPercent)), resetsAt: value.resetsAt ?? null }];
  }));
}

async function readProviderStatus({ provider, kieAccountId, kie, routerAi, codex, now = () => new Date() }) {
  const checkedAt = now().toISOString();
  if (provider === 'media') {
    if (!['primary', 'secondary'].includes(kieAccountId)) throw Object.assign(new Error('Неизвестный аккаунт Kie'), { status: 400 });
    const selected = kie.selectAccount(kieAccountId);
    if (!selected.isConfigured()) throw Object.assign(new Error('Ключ Kie не подключён'), { status: 503 });
    const amount = balanceAmount(await selected.balance());
    if (amount === null) throw new Error('Kie не вернул остаток кредитов');
    return { provider, kieAccountId, checkedAt, balance: { amount, unit: 'credits' }, windows: [] };
  }
  if (provider === 'routerai') {
    if (!routerAi) throw Object.assign(new Error('RouterAI не настроен'), { status: 503 });
    return { provider, checkedAt, balance: { amount: await routerAi.credits(), unit: 'rub' }, windows: [] };
  }
  if (provider === 'codex') {
    if (!codex) throw Object.assign(new Error('Codex не подключён'), { status: 503 });
    return { provider, checkedAt, balance: null, windows: codexWindows(await codex()) };
  }
  throw Object.assign(new Error('Неизвестный поставщик'), { status: 400 });
}

module.exports = { readProviderStatus, codexWindows };
