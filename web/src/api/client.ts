import type { Catalog, Chat, CodexCatalog, GenerationRecord, Project, QueueStatus, ReleaseInfo } from '../types';

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
    throw new Error('Сессия завершена');
  }
  if (!response.ok || body === null) {
    const message = body && typeof body === 'object' && 'error' in body ? body.error : 'Некорректный ответ сервиса';
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
export const loadDraft = (chatId?: string | null) => rpc<Record<string, unknown> | null>('loadDrafts', chatId ? [{ chatId }] : []);
export const saveDraft = (draft: Record<string, unknown>, chatId?: string | null) => rpc<boolean>('saveDrafts', [draft, chatId ? { chatId } : {}]);

export async function getQueueStatus(): Promise<QueueStatus> {
  return rpc<QueueStatus>('queueStatus');
}

export async function getMediaQuote(modelId: string, input: Record<string, unknown>): Promise<{ credits: number; amountUnits: number }> {
  return rpc('nativeQuote', [{ modelId, input }]);
}

export type StartupStatus = {
  database: { state: 'connecting' | 'connected' | 'unavailable' | 'disabled'; code?: string; attempt?: number; retryInMs?: number; latencyMs?: number };
  provider: { state: 'idle' | 'checking' | 'ready' | 'error'; checkedAt?: string; model?: { id: string; name: string }; quote?: { credits?: number } | null; checks?: Array<{ step: string; status: string; durationMs: number }> };
  authenticated: boolean;
  account: { id: string; role: string } | null;
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
};

export async function diagnoseProvider(modelId: string, input: Record<string, unknown>): Promise<ProviderDiagnostics> {
  return rpc('diagnoseProvider', [{ modelId, input }]);
}

export async function uploadSource(file: File, context: { projectId?: string | null; chatId?: string | null } = {}): Promise<{ ref: string; name?: string; type?: string; [key: string]: unknown }> {
  const query = new URLSearchParams({ name: file.name });
  if (context.projectId) query.set('projectId', context.projectId);
  if (context.chatId) query.set('chatId', context.chatId);
  const response = await fetch(`/api/source?${query}`, { method: 'POST', headers: { ...accountHeaders(), 'Content-Type': file.type || 'application/octet-stream' }, body: file });
  const body = await parse<RpcResult<{ ref: string; name?: string; type?: string; [key: string]: unknown }>>(response);
  return body.result;
}

export async function createTask(input: { modelId: string; input: Record<string, unknown>; requestId: string; projectId?: string | null; chatId?: string | null; sourceFiles?: Array<Record<string, unknown>> }): Promise<GenerationRecord> {
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

export function subscribeToChanges(onChange: () => void): () => void {
  const events = new EventSource('/api/events');
  const handler = () => onChange();
  events.addEventListener('message', handler);
  events.onerror = () => { /* native EventSource reconnects; the next message refreshes state */ };
  return () => { events.removeEventListener('message', handler); events.close(); };
}
