const { assertAdminRole } = require('../../auth/roles');
const { readProviderStatus } = require('../../services/provider-status');

async function handleAdminRequest({ req, url, user, accounts, config, kieBrowserControl, kieBrowserSession, routerAiStatus, apimart, send, readBody }) {
  if (!accounts) return send(403, { error: 'Доступ запрещён' });
  assertAdminRole(user.role);
  if (url.pathname === '/api/admin/kie-session/status' && req.method === 'GET') {
    if (kieBrowserControl && !kieBrowserControl.running()) return send(200, { result: { state: 'sleeping', loginUrl: null, embedded: true } });
    return send(200, { result: await kieBrowserSession.status() });
  }
  if (url.pathname === '/api/admin/kie-session/frame' && req.method === 'GET') {
    if (!config.kieBrowser?.embedded) return send(404, { error: 'Встроенный браузер не включён' });
    await kieBrowserControl?.ensureActive();
    const result = await kieBrowserSession.frame();
    kieBrowserControl?.touch();
    return send(200, { result });
  }
  if (url.pathname === '/api/admin/kie-session/input' && req.method === 'POST') {
    if (!config.kieBrowser?.embedded || req.headers['x-media-client'] !== 'web') return send(404, { error: 'Встроенный браузер не включён' });
    const action = JSON.parse((await readBody(4096)).toString('utf8'));
    await kieBrowserControl?.ensureActive();
    await kieBrowserSession.input(action);
    kieBrowserControl?.touch();
    return send(200, { result: { ok: true } });
  }
  if (url.pathname === '/api/admin/credit-conversion' && req.method === 'GET') {
    return send(200, { result: accounts.conversion.snapshot() });
  }
  if (url.pathname === '/api/admin/provider-status' && req.method === 'GET') {
    const provider = url.searchParams.get('provider');
    const kieAccountId = url.searchParams.get('kieAccountId') || 'primary';
    const codexLimits = config.codex?.url ? async () => {
      const response = await fetch(`${config.codex.url.replace(/\/$/, '')}/auth/limits`, {
        headers: { 'x-account-id': user.id }, signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error('Не удалось прочитать лимиты Codex');
      return response.json();
    } : null;
    try { return send(200, await readProviderStatus({ provider, kieAccountId, kie: accounts.provider,
      routerAi: routerAiStatus, apimart: apimart?.provider.getStatus, codex: codexLimits })); }
    catch (error) { return send(error.status === 400 ? 400 : 502, { error: error.message || 'Не удалось проверить поставщика' }); }
  }
  if (url.pathname === '/api/admin/kie-submissions' && req.method === 'GET') {
    return send(200, { result: await accounts.kieSubmissionStatistics(url.searchParams.get('days') || 30) });
  }
  if (url.pathname === '/api/admin/billing-reconciliation' && req.method === 'GET') {
    return send(200, { result: await accounts.billingReconciliation(url.searchParams.get('days') || 30) });
  }
  if (url.pathname === '/api/admin/operations' && req.method === 'GET') {
    return send(200, { result: await accounts.operationsMetrics() });
  }
  if (url.pathname.startsWith('/api/admin/codex/')) {
    const action = url.pathname.slice('/api/admin/codex/'.length);
    if (!((action === 'status' && req.method === 'GET') || (['start', 'cancel'].includes(action) && req.method === 'POST' && req.headers['x-media-client'] === 'web'))) return send(404, { error: 'Не найдено' });
    if (!config.codex?.url) return send(503, { error: 'Сервис Codex не подключён на сервере.' });
    try {
      const response = await fetch(`${config.codex.url.replace(/\/$/, '')}/auth/${action}`, { method: req.method, headers: { 'x-account-id': user.id }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) return send(502, { error: 'Обновите и проверьте сервис Codex на сервере.' });
      return send(200, { result: await response.json() });
    } catch { return send(502, { error: 'Сервис Codex не отвечает. Проверьте его запуск.' }); }
  }
  if (url.pathname === '/api/admin/accounts' && req.method === 'GET') return send(200, { result: await accounts.list() });
  if (url.pathname === '/api/admin/starter-pack' && req.method === 'GET') return send(200, { result: await accounts.starterOverview() });
  if (url.pathname === '/api/admin/roles' && req.method === 'POST' && req.headers['x-media-client'] === 'web') {
    const body = JSON.parse((await readBody(4096)).toString('utf8'));
    await accounts.setRole(user.id, body.accountId, body.role, body.reason);
    return send(200, { result: true });
  }
  if (url.pathname === '/api/admin/roles' && req.method === 'GET') return send(200, { result: await accounts.audit() });
  if (url.pathname === '/api/admin/ledger' && req.method === 'GET') return send(200, { result: await accounts.ledger(url.searchParams.get('account')) });
  if (url.pathname === '/api/admin/reconcile' && req.method === 'POST' && req.headers['x-media-client'] === 'web') {
    const body = JSON.parse((await readBody(8192)).toString('utf8'));
    const result = await accounts.reconcile(user.id, body.accountId, body.jobId, body.outcome, body.evidence);
    return send(200, { result });
  }
  if (url.pathname === '/api/admin/grant' && req.method === 'POST' && req.headers['x-media-client'] === 'web') {
    const body = JSON.parse((await readBody(4096)).toString('utf8'));
    await accounts.wallet.grant(user.id, body.accountId, body.amountUnits, body.reference, body.note);
    return send(200, { result: await accounts.wallet.get(body.accountId) });
  }
  return send(404, { error: 'Метод не найден' });
}

module.exports = { handleAdminRequest };
