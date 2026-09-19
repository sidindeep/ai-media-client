import type { Catalog, CodexCatalog, GenerationRecord, QueueStatus } from '../types';

type RpcResult<T> = { result: T };

function accountHeaders(): HeadersInit {
  const account = document.querySelector('meta[name="account-id"]')?.getAttribute('content') || 'local';
  return { 'X-Media-Client': 'web', 'X-Media-User': account };
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

export async function getHistory(): Promise<GenerationRecord[]> {
  return rpc<GenerationRecord[]>('getHistory');
}

export async function getQueueStatus(): Promise<QueueStatus> {
  return rpc<QueueStatus>('queueStatus');
}

export async function createTask(input: { modelId: string; input: Record<string, unknown>; requestId: string }): Promise<GenerationRecord> {
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
