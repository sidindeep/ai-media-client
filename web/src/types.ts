export type GenerationState =
  | 'queued'
  | 'preparing'
  | 'submitting'
  | 'waiting'
  | 'queuing'
  | 'generating'
  | 'running'
  | 'success'
  | 'fail'
  | 'blocked'
  | 'unknown'
  | 'unconfirmed'
  | 'cancelled';

export type MediaModel = {
  id: string;
  apiModel?: string;
  providerId: string;
  name: string;
  kind?: string;
  fields?: Array<Record<string, unknown>>;
  inputSchema?: Record<string, unknown>;
};
export type Catalog = {
  providers: Array<{ id: string; name: string }>;
  models: MediaModel[];
};

export type GenerationRecord = {
  id: string;
  providerId: string;
  providerName?: string;
  modelId?: string;
  modelName?: string;
  kind?: string;
  state: GenerationState;
  createdAt?: string;
  updatedAt?: string;
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
  resultJson?: string;
  localFiles?: Array<{ previewUrl?: string; url?: string; name?: string }>;
  nativeQuote?: { credits?: number };
  generationDurationMs?: number;
  usage?: { total_tokens?: number };
};

export type QueueStatus = {
  paused: boolean;
  error: string | null;
  concurrency: number;
};

export type CodexModel = {
  id: string;
  name: string;
  efforts: string[];
  defaultEffort: string;
  inputModalities?: string[];
};

export type CodexCatalog = {
  models: CodexModel[];
  uiDefaults?: { model?: string; effort?: string; speed?: string; kind?: string };
};
