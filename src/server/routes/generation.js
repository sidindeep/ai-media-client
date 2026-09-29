const { validateCodexRequest } = require('../../services/codex-request');
const { validateRouterAiRequest } = require('../../services/routerai-billing');
const { isAdminRole, assertAdminRole } = require('../../auth/roles');
const snapshotCatalog = require('../../../config/codex-models.json');

async function handleGenerationRequest({ req, res, url, user, accounts, codex, codexProvider, routerAi, apimart, costRouter, routerAiModels,
  send, readBody, sendMedia, sendStored, sendFile, headers }) {
  if (url.pathname.startsWith('/api/auto/')) {
    await accounts?.starterPack?.assertProvider(user.id, user.role, 'media');
    if (!costRouter) return send(503, { error: 'Автоматический выбор не настроен' });
    if (req.method !== 'POST' || !['/api/auto/quote', '/api/auto/jobs'].includes(url.pathname)) return send(404, { error: 'Не найдено' });
    if (req.headers['x-media-client'] !== 'web') return send(403, { error: 'Недопустимый источник запроса' });
    const raw = JSON.parse((await readBody(50000)).toString('utf8'));
    if (url.pathname.endsWith('/quote')) {
      const quote = await costRouter.quote(user, raw);
      if (isAdminRole(user.role)) return send(200, quote);
      const publicOffer = offer => ({ providerId: offer.providerId, modelId: offer.modelId,
        credits: offer.credits, unavailable: offer.unavailable, reason: offer.reason });
      return send(200, { selected: quote.selected && publicOffer(quote.selected), offers: quote.offers.map(publicOffer) });
    }
    return send(200, await costRouter.submit(user, raw));
  }
  if (url.pathname.startsWith('/api/codex/')) {
    await accounts?.starterPack?.assertProvider(user.id, user.role, 'codex');
    if (req.method === 'GET' && url.pathname === '/api/codex/status') return send(200, { enabled: Boolean(codexProvider), allowed: Boolean(accounts) });
    if (!codex) return send(503, { error: 'Codex требует подключённого сервиса и кредитного счёта.' });
    if (req.method === 'GET' && url.pathname === '/api/codex/models') {
      try { return send(200, { ...await codex.models(), uiDefaults: snapshotCatalog.uiDefaults }); }
      catch { return send(503, { error: 'Каталог Codex временно недоступен.' }); }
    }
    const imageRequest = /^\/api\/codex\/jobs\/([a-f0-9-]{36})\/image$/.exec(url.pathname);
    if (imageRequest && ['GET', 'HEAD'].includes(req.method)) {
      const selectedAccount = url.searchParams.get('account');
      if (selectedAccount) await accounts.scope(user, selectedAccount);
      const file = await codex.image(selectedAccount || user.id, imageRequest[1]);
      return await sendMedia(() => file.storageKey
        ? sendStored(file, url.searchParams.get('download') === '1')
        : sendFile(file, 'image/png', url.searchParams.get('download') === '1'));
    }
    if (req.method === 'GET' && url.pathname === '/api/codex/quote') {
      try { return send(200, { quote: codexProvider.quote({ model: url.searchParams.get('model'), effort: url.searchParams.get('effort'), speed: url.searchParams.get('speed') }).nativeQuote }); }
      catch { return send(200, { quote: null, error: 'Цена этого режима Codex ещё не опубликована.' }); }
    }
    const jobPath = /^\/api\/codex\/jobs(?:\/[a-f0-9-]{36})?$/.test(url.pathname);
    if (!jobPath || !['GET', 'POST'].includes(req.method) || (req.method === 'POST' && url.pathname !== '/api/codex/jobs')) return send(404, { error: 'Не найдено' });
    if (req.method === 'POST') {
      if (req.headers['x-media-client'] !== 'web') return send(403, { error: 'Недопустимый источник запроса' });
      const raw = JSON.parse((await readBody(100000)).toString('utf8'));
      const body = validateCodexRequest(raw, (await codex.models()).models);
      const binding = await accounts.workspaces.assertBinding(user.id, body.projectId, body.chatId);
      return send(200, await codexProvider.submit(user.id, { ...body, ...binding }));
    }
    return send(200, await codexProvider.getTask(user.id, url.pathname.split('/').pop()));
  }
  if (url.pathname.startsWith('/api/apimart/')) {
    if (req.method === 'GET' && (url.pathname === '/api/apimart/models'
      || /^\/api\/apimart\/jobs\/[a-f0-9-]{36}$/.test(url.pathname)))
      await accounts?.starterPack?.assertProvider(user.id, user.role, 'media');
    else assertAdminRole(user.role);
    if (!apimart) return send(503, { error: 'APIMart не настроен' });
    if (req.method === 'GET' && url.pathname === '/api/apimart/models') {
      try { return send(200, { models: await apimart.models() }); }
      catch (error) { return send(200, { models: [], error: error.status === 402
        ? 'APIMart требует пополнить баланс для загрузки каталога.' : 'Каталог APIMart временно недоступен.' }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/apimart/quote') {
      if (req.headers['x-media-client'] !== 'web') return send(403, { error: 'Недопустимый источник запроса' });
      const raw = JSON.parse((await readBody(50000)).toString('utf8'));
      return send(200, await apimart.quote(raw));
    }
    if (req.method === 'POST' && url.pathname === '/api/apimart/jobs') {
      if (req.headers['x-media-client'] !== 'web') return send(403, { error: 'Недопустимый источник запроса' });
      const raw = JSON.parse((await readBody(100000)).toString('utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return send(400, { error: 'Некорректный запрос APIMart' });
      const binding = await accounts.workspaces.assertBinding(user.id, raw.projectId, raw.chatId);
      return send(200, await apimart.submit(user.id, { ...raw, ...binding }));
    }
    const jobRequest = /^\/api\/apimart\/jobs\/([a-f0-9-]{36})$/.exec(url.pathname);
    if (req.method === 'GET' && jobRequest) {
      const job = await apimart.get(user.id, jobRequest[1]);
      return job ? send(200, job) : send(404, { error: 'Запрос не найден' });
    }
    return send(404, { error: 'Не найдено' });
  }
  if (url.pathname.startsWith('/api/routerai/')) {
    await accounts?.starterPack?.assertProvider(user.id, user.role, 'media');
    if (!routerAi) return send(503, { error: 'RouterAI не настроен.' });
    if (req.method === 'GET' && url.pathname === '/api/routerai/models') return send(200, await routerAiModels.list(user.role));
    if (url.pathname.startsWith('/api/routerai/admin/')) {
      assertAdminRole(user.role);
      if (req.method === 'GET' && url.pathname === '/api/routerai/admin/models') return send(200, await routerAiModels.all(user.role));
      if (req.method === 'POST' && url.pathname === '/api/routerai/admin/jobs') {
        if (req.headers['x-media-client'] !== 'web') return send(403, { error: 'Недопустимый источник запроса' });
        const raw = JSON.parse((await readBody(300000)).toString('utf8'));
        const binding = await accounts.workspaces.assertBinding(user.id, raw.projectId, raw.chatId);
        return send(200, await routerAi.submitAdmin(user.id, { ...raw, ...binding }, (await routerAiModels.all(user.role)).models));
      }
      const adminVideo = /^\/api\/routerai\/admin\/jobs\/([a-f0-9-]{36})\/video\/(status|content)$/.exec(url.pathname);
      if (req.method === 'GET' && adminVideo) {
        if (adminVideo[2] === 'status') return send(200, await routerAi.adminVideo(user.id, adminVideo[1]));
        const bytes = await routerAi.adminVideo(user.id, adminVideo[1], true);
        res.writeHead(200, { ...headers, 'Content-Type': 'video/mp4', 'Content-Length': bytes.length,
          'Content-Disposition': `attachment; filename="routerai-${adminVideo[1]}.mp4"`, 'Cache-Control': 'no-store' });
        res.end(bytes); return;
      }
      return send(404, { error: 'Не найдено' });
    }
    if (req.method === 'GET' && url.pathname === '/api/routerai/quote') {
      try {
        const allowed = (await routerAiModels.list(user.role)).models;
        const model = allowed.find(item => item.id === url.searchParams.get('model'));
        if (!model) return send(403, { quote: null, error: 'Модель RouterAI недоступна.' });
        const rawPayload = url.searchParams.get('payload') || '{}';
        if (rawPayload.length > 4096) return send(400, { quote: null, error: 'Параметры слишком длинные.' });
        const payload = JSON.parse(rawPayload);
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return send(400, { quote: null, error: 'Некорректные параметры.' });
        return send(200, { quote: await routerAi.quote({ model: model.id, endpoint: model.endpoint ||
          (model.kind === 'image' ? 'images' : 'chat/completions'), payload }, user.role) });
      }
      catch (error) { return send(200, { quote: null, error: error.message || 'Цена модели RouterAI не опубликована.' }); }
    }
    const imageRequest = /^\/api\/routerai\/jobs\/([a-f0-9-]{36})\/image$/.exec(url.pathname);
    if (imageRequest && ['GET', 'HEAD'].includes(req.method)) {
      const file = await routerAi.image(user.id, imageRequest[1]);
      return sendMedia(() => file.storageKey
        ? sendStored(file, url.searchParams.get('download') === '1' || file.type === 'image/svg+xml')
        : sendFile(file.path, file.type, url.searchParams.get('download') === '1' || file.type === 'image/svg+xml'));
    }
    if (req.method === 'POST' && url.pathname === '/api/routerai/jobs') {
      if (req.headers['x-media-client'] !== 'web') return send(403, { error: 'Недопустимый источник запроса' });
      const allowed = (await routerAiModels.list(user.role)).models;
      const raw = JSON.parse((await readBody(100000)).toString('utf8'));
      const body = validateRouterAiRequest(raw, allowed);
      const binding = await accounts.workspaces.assertBinding(user.id, body.projectId, body.chatId);
      const job = await routerAi.submit(user.id, { ...raw, ...binding }, user.role, allowed);
      if (!isAdminRole(user.role)) delete job.providerCostRub;
      return send(200, job);
    }
    const jobRequest = /^\/api\/routerai\/jobs\/([a-f0-9-]{36})$/.exec(url.pathname);
    if (req.method === 'GET' && jobRequest) {
      const job = await routerAi.get(user.id, jobRequest[1]);
      if (job && !isAdminRole(user.role)) delete job.providerCostRub;
      return job ? send(200, job) : send(404, { error: 'Запрос не найден' });
    }
    return send(404, { error: 'Не найдено' });
  }
}

module.exports = { handleGenerationRequest };
