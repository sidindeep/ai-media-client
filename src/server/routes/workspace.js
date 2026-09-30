const { performance } = require('node:perf_hooks');

async function handleWorkspaceRequest({ req, url, user, accounts, send, readBody, recordSystemEvent, recordSystemInfo }) {
  if (accounts && req.method === 'GET' && url.pathname === '/api/workspace/history') {
    const startedAt = performance.now();
    const selected = req.headers['x-media-account'] || url.searchParams.get('account') || undefined;
    const historyRequest = { cursor: url.searchParams.get('cursor') || null };
    if (url.searchParams.has('chatId')) historyRequest.chatId = url.searchParams.get('chatId');
    try {
      const scoped = await accounts.scope(user, selected);
      const result = await scoped.dispatch('getHistoryPage', [historyRequest]);
      if (historyRequest.chatId) recordSystemInfo('studio', 'chat.history.loaded', 'Chat history loaded', {
        accountId: selected || user.id, chatId: historyRequest.chatId.slice(0, 80), cursorPresent: Boolean(historyRequest.cursor),
        records: result.records.length, hasNext: Boolean(result.next), durationMs: Math.round(performance.now() - startedAt),
      });
      return send(200, { result });
    } catch (error) {
      if (historyRequest.chatId) recordSystemEvent('studio', 'chat.history.failed', error, {
        accountId: selected || user.id, chatId: historyRequest.chatId.slice(0, 80), cursorPresent: Boolean(historyRequest.cursor),
        durationMs: Math.round(performance.now() - startedAt),
      });
      throw error;
    }
  }
  if (accounts && req.method === 'GET' && url.pathname === '/api/workspace/sync') {
    const startedAt = performance.now();
    const selectedWorkspaceAccount = req.headers['x-media-account'] || url.searchParams.get('account') || undefined;
    const workspaceAccount = selectedWorkspaceAccount || user.id;
    const scopedService = await accounts.scope(user, selectedWorkspaceAccount);
    const rawSince = url.searchParams.get('since');
    const since = rawSince ? new Date(rawSince) : null;
    if (since && Number.isNaN(since.getTime())) return send(400, { error: 'Некорректный курсор синхронизации' });
    if (!since) await accounts.workspaces.ensureDefaultChatId(workspaceAccount);
    const activeIds = url.searchParams.getAll('active');
    if (activeIds.length > 20 || activeIds.some(id => !/^(?:(?:codex|routerai|apimart):)?[a-f0-9-]{36}$/.test(id))) return send(400, { error: 'Некорректный список активных задач' });
    const { cursor, unassignedCount } = await accounts.workspaceSyncReadModel(workspaceAccount, !since);
    const [historyResult, activeRecords, projects, chats, queue] = await Promise.all([
      scopedService.dispatch(since ? 'getHistoryDelta' : 'getHistoryPage', since ? [{ since: since.toISOString(), before: cursor, activeIds }] : [{ cursor: null }]),
      since ? [] : scopedService.dispatch('getHistoryActive'),
      since ? accounts.workspaces.listProjectChanges(workspaceAccount, since.toISOString(), cursor) : accounts.workspaces.listProjects(workspaceAccount),
      since ? accounts.workspaces.listChatChanges(workspaceAccount, since.toISOString(), cursor) : accounts.workspaces.listChats(workspaceAccount),
      scopedService.dispatch('queueStatus'),
    ]);
    const records = since ? historyResult : [...activeRecords, ...historyResult.records];
    if (!since) recordSystemInfo('studio', 'chat.sync.loaded', 'Workspace snapshot loaded', {
      accountId: workspaceAccount, chatId: url.searchParams.get('chatId')?.slice(0, 80) || null, records: records.length,
      unassignedCount, hasNext: Boolean(historyResult.next), durationMs: Math.round(performance.now() - startedAt),
    });
    return send(200, { result: { cursor, full: !since, records, historyNext: since ? undefined : historyResult.next,
      unassignedCount: since ? undefined : unassignedCount, projects, chats, queue } });
  }
  if (accounts && /^\/api\/(projects|chats)(?:\/[^/]+(?:\/(archive|restore|move))?)?$/.test(url.pathname)) {
    const selectedWorkspaceAccount = req.headers['x-media-account'] || url.searchParams.get('account') || undefined;
    const workspaceAccount = selectedWorkspaceAccount || user.id;
    const workspaceService = await accounts.scope(user, selectedWorkspaceAccount);
    const workspacePath = url.pathname.split('/').filter(Boolean);
    const resource = workspacePath[1], resourceId = workspacePath[2], action = workspacePath[3];
    const workspaceBody = async limit => JSON.parse((await readBody(limit)).toString('utf8'));
    const workspaceChanged = result => { workspaceService.events?.emit('changed'); return send(200, { result }); };
    if (resource === 'projects') {
      if (req.method === 'GET' && !resourceId) return send(200, { result: await accounts.workspaces.listProjects(workspaceAccount, url.searchParams.get('includeArchived') === 'true') });
      if (req.method === 'POST' && !resourceId && req.headers['x-media-client'] === 'web') return workspaceChanged(await accounts.workspaces.createProject(workspaceAccount, (await workspaceBody(4096)).name));
      if (req.method === 'PATCH' && resourceId && !action && req.headers['x-media-client'] === 'web') return workspaceChanged(await accounts.workspaces.renameProject(workspaceAccount, resourceId, (await workspaceBody(4096)).name));
      if (req.method === 'POST' && resourceId && action === 'archive' && req.headers['x-media-client'] === 'web') return workspaceChanged(await accounts.workspaces.archiveProject(workspaceAccount, resourceId));
      if (req.method === 'POST' && resourceId && action === 'restore' && req.headers['x-media-client'] === 'web') return workspaceChanged(await accounts.workspaces.restoreProject(workspaceAccount, resourceId));
    }
    if (resource === 'chats') {
      if (req.method === 'GET' && !resourceId) {
        const projectFilter = url.searchParams.has('projectId') ? (url.searchParams.get('projectId') || null) : undefined;
        return send(200, { result: await accounts.workspaces.listChats(workspaceAccount, { projectId: projectFilter, includeArchived: url.searchParams.get('includeArchived') === 'true' }) });
      }
      if (req.method === 'GET' && resourceId && !action) return send(200, { result: await accounts.workspaces.getChat(workspaceAccount, resourceId) });
      if (req.method === 'POST' && !resourceId && req.headers['x-media-client'] === 'web') return workspaceChanged(await accounts.workspaces.createChat(workspaceAccount, await workspaceBody(8192)));
      if (req.method === 'PATCH' && resourceId && !action && req.headers['x-media-client'] === 'web') return workspaceChanged(await accounts.workspaces.renameChat(workspaceAccount, resourceId, (await workspaceBody(4096)).name));
      if (req.method === 'POST' && resourceId && action === 'archive' && req.headers['x-media-client'] === 'web') return workspaceChanged(await accounts.workspaces.archiveChat(workspaceAccount, resourceId));
      if (req.method === 'POST' && resourceId && action === 'restore' && req.headers['x-media-client'] === 'web') return workspaceChanged(await accounts.workspaces.restoreChat(workspaceAccount, resourceId));
      if (req.method === 'DELETE' && resourceId && !action && req.headers['x-media-client'] === 'web') return workspaceChanged(await accounts.workspaces.deleteChat(workspaceAccount, resourceId));
      if (req.method === 'POST' && resourceId && action === 'move' && req.headers['x-media-client'] === 'web') return workspaceChanged(await accounts.workspaces.moveChat(workspaceAccount, resourceId, (await workspaceBody(4096)).projectId ?? null));
    }
    return send(404, { error: 'Метод не найден' });
  }
}

module.exports = { handleWorkspaceRequest };
