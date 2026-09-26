import type { Account, Catalog, Chat, CodexCatalog, GenerationJournalPage, GenerationPreset, GenerationRecord, Project, QueueStatus, ReleaseInfo, RouterAiCatalog, SpendingCategory, SpendingPageData, WorkspaceSync } from '../types';
import { t } from '../i18n';

type RpcResult<T> = { result: T };

function accountHeaders(): HeadersInit {
  const account = document.querySelector('meta[name="account-id"]')?.getAttribute('content') || 'local';
  return { 'X-Media-Client': 'web', 'X-Media-User': account };
}
export function setAccountContext(account: { id: string; role: string }) {
  document.querySelector('meta[name="account-id"]')?.setAttribute('content', account.id);
  document.querySelector('meta[name="account-role"]')?.setAttribute('content', account.role);
}
async function parse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as { error?: string } | T | null;
  if (response.status === 401) {
    window.location.assign('/login');
    throw new Error(t('error.sessionExpired'));
  }
  if (!response.ok || body === null) {
    const message = body && typeof body === 'object' && 'error' in body ? body.error : t('error.invalidResponse');
    throw new Error(String(message));
  }
  return body as T;
}

export async function rpc<T>(method: string, args: unknown[] = []): Promise<T> {
  const response = await fetch(`/api/rpc/${method}`, {
    method: 'POST',
    headers: { ...accountHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const body = await parse<RpcResult<T>>(response);
  return body.result;
}

export async function getCatalog(): Promise<Catalog> {
  return rpc<Catalog>('getCatalog');
}

export async function getRelease(): Promise<ReleaseInfo> {
  const response = await fetch('/api/version', { cache: 'no-store' });
  return parse<ReleaseInfo>(response);
}

export async function getHistory(): Promise<GenerationRecord[]> {
  return rpc<GenerationRecord[]>('getHistory');
}

export function getSpending(input: { days: 7 | 30 | 90; category: SpendingCategory; cursor?: string | null; asOf?: string }) {
  return rpc<SpendingPageData>('getSpending', [input]);
}
export function getGenerationJournal(input: { provider: 'all' | 'kie' | 'routerai' | 'codex'; offset?: number }) {
  return rpc<GenerationJournalPage>('getGenerationJournal', [input]);
}

async function workspaceRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, headers: { ...accountHeaders(), ...(init.headers || {}), ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
  const body = await parse<{ result: T }>(response);
  return body.result;
}

export const getProjects = (includeArchived = false) => workspaceRequest<Project[]>(`/api/projects?includeArchived=${includeArchived}`);
export const createProject = (name: string) => workspaceRequest<Project>('/api/projects', { method: 'POST', body: JSON.stringify({ name }) });
export const renameProject = (id: string, name: string) => workspaceRequest<Project>(`/api/projects/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name }) });
export const archiveProject = (id: string) => workspaceRequest<Project>(`/api/projects/${encodeURIComponent(id)}/archive`, { method: 'POST', body: '{}' });
export const getChats = (projectId?: string | null, includeArchived = false) => workspaceRequest<Chat[]>(`/api/chats?${projectId === undefined ? '' : `projectId=${encodeURIComponent(projectId || '')}&`}includeArchived=${includeArchived}`);
export const createChat = (name: string, projectId?: string | null) => workspaceRequest<Chat>('/api/chats', { method: 'POST', body: JSON.stringify({ name, projectId: projectId ?? null }) });
export const renameChat = (id: string, name: string) => workspaceRequest<Chat>(`/api/chats/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name }) });
export const moveChat = (id: string, projectId: string | null) => workspaceRequest<Chat>(`/api/chats/${encodeURIComponent(id)}/move`, { method: 'POST', body: JSON.stringify({ projectId }) });
export const archiveChat = (id: string) => workspaceRequest<Chat>(`/api/chats/${encodeURIComponent(id)}/archive`, { method: 'POST', body: '{}' });
export const getChat = (id: string) => workspaceRequest<Chat & { records: GenerationRecord[] }>(`/api/chats/${encodeURIComponent(id)}`);
export const getWorkspaceSync = (since?: string | null, activeIds: string[] = []) => {
  const query = new URLSearchParams();
  if (since) query.set('since', since);
  for (const id of activeIds.slice(0, 20)) query.append('active', id);
  return workspaceRequest<WorkspaceSync>(`/api/workspace/sync${query.size ? `?${query}` : ''}`);
};
export const loadDraft = (chatId?: string | null) => rpc<Record<string, unknown> | null>('loadDrafts', chatId ? [{ chatId }] : []);
export const saveDraft = (draft: Record<string, unknown>, chatId?: string | null) => rpc<boolean>('saveDrafts', [draft, chatId ? { chatId } : {}]);
export const listGenerationPresets = () => rpc<GenerationPreset[]>('listGenerationPresets');
export const saveGenerationPreset = (preset: Omit<GenerationPreset, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }) => rpc<GenerationPreset>('saveGenerationPreset', [preset]);
export const removeGenerationPreset = (id: string) => rpc<boolean>('removeGenerationPreset', [id]);

export async function getQueueStatus(): Promise<QueueStatus> {
  return rpc<QueueStatus>('queueStatus');
}

export const getAccount = () => workspaceRequest<Account>('/api/account');
export const updateAccountProfile = (name: string) => workspaceRequest<{ name: string }>('/api/account/profile', { method: 'POST', body: JSON.stringify({ name }) });
export const getTelegramLinkStatus = () => workspaceRequest<{ linked: boolean; available: boolean; telegramUserId?: string; username?: string | null; linkedAt?: string }>('/api/account/telegram');
export const createTelegramLink = () => workspaceRequest<{ url: string; expiresInSeconds: number }>('/api/account/telegram/link', { method: 'POST', body: '{}' });
export const unlinkTelegram = () => workspaceRequest<boolean>('/api/account/telegram/unlink', { method: 'POST', body: '{}' });
export const getStorageSettings = () => rpc<{ autoSave: boolean }>('storageSettings');
export const setAutoSave = (autoSave: boolean) => rpc<{ autoSave: boolean }>('setAutoSave', [autoSave]);
export const logout = () => workspaceRequest<boolean>('/auth/logout', { method: 'POST', body: '{}' });

export type CommerceOffer = { id: string; version: string; name: string; description: string; creditUnits: number; amountMinor: number; currency: string; active: boolean; checkoutMode?: 'stub' | 'redirect' };
export type CommerceOrder = { id: string; status: string; offer: CommerceOffer; amountMinor: number; currency: string; creditUnits: number; paymentId: string | null; confirmationUrl: string | null; checkoutMode?: 'stub' | 'redirect'; createdAt: string; updatedAt: string };
export const getCommerceOffers = () => workspaceRequest<CommerceOffer[]>('/api/commerce/offers');
export const listCommerceOrders = () => workspaceRequest<CommerceOrder[]>('/api/commerce/orders');
export const createCommerceOrder = (offer: CommerceOffer, idempotencyKey: string) => workspaceRequest<CommerceOrder>('/api/commerce/orders', {
  method: 'POST', body: JSON.stringify({ offerId: offer.id, offerVersion: offer.version, idempotencyKey }),
});
export const checkoutCommerceOrder = (orderId: string) => workspaceRequest<CommerceOrder>(`/api/commerce/orders/${encodeURIComponent(orderId)}/checkout`, { method: 'POST', body: '{}' });
export const getCommerceOrder = (orderId: string) => workspaceRequest<CommerceOrder>(`/api/commerce/orders/${encodeURIComponent(orderId)}`);

export async function getMediaQuote(modelId: string, input: Record<string, unknown>, sourceFiles: Array<Record<string, unknown>> = []): Promise<{ credits: number | null; amountUnits: number | null; status?: string; warning?: string }> {
  return rpc('nativeQuote', [{ modelId, input, sourceFiles }]);
}

export type StartupStatus = {
  database: { state: 'connecting' | 'connected' | 'unavailable' | 'disabled'; code?: string; attempt?: number; retryInMs?: number; latencyMs?: number };
  provider: { state: 'idle' | 'checking' | 'ready' | 'error'; checkedAt?: string; model?: { id: string; name: string }; quote?: { credits?: number } | null; checks?: Array<{ step: string; status: string; durationMs: number }> };
  authenticated: boolean;
  account: { id: string; role: string; starterPack?: Account['starterPack'] } | null;
};

export async function getStartupStatus(): Promise<StartupStatus> {
  const response = await fetch('/api/startup', { cache: 'no-store' });
  return parse<StartupStatus>(response);
}

export type ProviderDiagnosticEntry = { time: string; step: string; status: 'ok' | 'error'; message: string; durationMs: number };
export type ProviderDiagnostics = {
  ok: boolean;
  configured: boolean;
  checkedAt: string;
  provider: string;
  model: { id: string; name: string };
  quote: { credits?: number; version?: string } | null;
  mechanism: { credentials: string; authorization: string; tariffs: string; generation: string };
  checks: ProviderDiagnosticEntry[];
  recentLogs: ProviderDiagnosticEntry[];
  balance?: number | null;
};

export type ProviderStatus = {
  provider: 'media' | 'routerai' | 'codex';
  kieAccountId?: 'primary' | 'secondary';
  checkedAt: string;
  balance: { amount: number; unit: 'credits' | 'rub' } | null;
  windows: Array<{ name: string; windowMinutes: number | null; remainingPercent: number; resetsAt: number | null }>;
};

export async function getProviderStatus(provider: ProviderStatus['provider'], kieAccountId = 'primary'): Promise<ProviderStatus> {
  const query = new URLSearchParams({ provider, kieAccountId });
  return parse(await fetch(`/api/admin/provider-status?${query}`, { headers: accountHeaders(), cache: 'no-store' }));
}

export async function diagnoseProvider(modelId: string, input: Record<string, unknown>, sourceFiles: Array<Record<string, unknown>> = [], kieAccountId = 'primary'): Promise<ProviderDiagnostics> {
  return rpc('diagnoseProvider', [{ modelId, input, sourceFiles, kieAccountId }]);
}

export async function uploadSource(file: File, context: { projectId?: string | null; chatId?: string | null } = {}): Promise<{ ref: string; name?: string; type?: string; [key: string]: unknown }> {
  const query = new URLSearchParams({ name: file.name });
  if (context.projectId) query.set('projectId', context.projectId);
  if (context.chatId) query.set('chatId', context.chatId);
  const response = await fetch(`/api/source?${query}`, { method: 'POST', headers: { ...accountHeaders(), 'Content-Type': file.type || 'application/octet-stream' }, body: file });
  const body = await parse<RpcResult<{ ref: string; name?: string; type?: string; [key: string]: unknown }>>(response);
  return body.result;
}

export async function createTask(input: { modelId: string; input: Record<string, unknown>; requestId: string; kieAccountId?: 'primary' | 'secondary'; projectId?: string | null; chatId?: string | null; sourceFiles?: Array<Record<string, unknown>> }): Promise<GenerationRecord> {
  return rpc<GenerationRecord>('createTask', [input]);
}

export async function startQueue(): Promise<boolean> {
  return rpc<boolean>('startQueue');
}

export async function pauseQueue(): Promise<boolean> {
  return rpc<boolean>('pauseQueue');
}

export async function setConcurrency(value: number): Promise<number> {
  return rpc<number>('setConcurrency', [value]);
}

export async function cancelQueued(id: string): Promise<unknown> {
  return rpc('cancelQueued', [id]);
}

export async function removeQueued(id: string): Promise<unknown> {
  return rpc('removeQueued', [id]);
}

export async function clearQueue(): Promise<unknown> {
  return rpc('clearQueue');
}

export async function getCodexCatalog(): Promise<CodexCatalog> {
  const response = await fetch('/codex-models.json', { headers: accountHeaders() });
  return parse<CodexCatalog>(response);
}

export async function getCodexQuote(model: string, effort: string, speed: string): Promise<{ quote: { credits: number } | null; error?: string }> {
  const query = new URLSearchParams({ model, effort, speed });
  const response = await fetch(`/api/codex/quote?${query}`, { headers: accountHeaders() });
  return parse(response);
}

export async function submitCodex(input: Record<string, unknown>): Promise<GenerationRecord & { state: string }> {
  const response = await fetch('/api/codex/jobs', {
    method: 'POST',
    headers: { ...accountHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return parse(response);
}

export async function getCodexJob(id: string): Promise<GenerationRecord> {
  const response = await fetch(`/api/codex/jobs/${encodeURIComponent(id)}`, { headers: accountHeaders() });
  return parse(response);
}

export async function getRouterAiCatalog(): Promise<RouterAiCatalog> {
  return parse(await fetch('/api/routerai/models', { headers: accountHeaders() }));
}

export async function getRouterAiQuote(model: string, payload: Record<string, unknown> = {}): Promise<{ quote: { credits: number | null; amountUnits: number | null; status?: string; warning?: string } | null; error?: string }> {
  return parse(await fetch(`/api/routerai/quote?${new URLSearchParams({ model, payload: JSON.stringify(payload) })}`, { headers: accountHeaders() }));
}

export async function submitRouterAi(input: Record<string, unknown>): Promise<GenerationRecord> {
  return parse(await fetch('/api/routerai/jobs', { method: 'POST',
    headers: { ...accountHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(input) }));
}

export async function getRouterAiJob(id: string): Promise<GenerationRecord> {
  return parse(await fetch(`/api/routerai/jobs/${encodeURIComponent(id)}`, { headers: accountHeaders() }));
}

export type RouterAiAdminModel = { id: string; name: string; kind: string; endpoint: string };
export async function getRouterAiAdminCatalog(): Promise<{ models: RouterAiAdminModel[] }> {
  return parse(await fetch('/api/routerai/admin/models', { headers: accountHeaders() }));
}

export async function submitRouterAiAdmin(input: { requestId: string; model: string; payload: Record<string, unknown>; quotedAmountUnits?: number; projectId?: string | null; chatId?: string | null }): Promise<GenerationRecord> {
  return parse(await fetch('/api/routerai/admin/jobs', { method: 'POST',
    headers: { ...accountHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(input) }));
}

export async function getRouterAiAdminVideoStatus(jobId: string): Promise<Record<string, unknown>> {
  return parse(await fetch(`/api/routerai/admin/jobs/${encodeURIComponent(jobId)}/video/status`, { headers: accountHeaders() }));
}

export function subscribeToChanges(onChange: (event: 'ready' | 'changed' | 'reset') => void): () => void {
  const events = new EventSource('/api/events');
  const handler = (event: MessageEvent) => {
    if (event.data === 'ready' || event.data === 'changed' || event.data === 'reset') onChange(event.data);
  };
  events.addEventListener('message', handler);
  events.onerror = () => { /* native EventSource reconnects; the next message refreshes state */ };
  return () => { events.removeEventListener('message', handler); events.close(); };
}
