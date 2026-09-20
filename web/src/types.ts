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
  fields?: MediaField[];
  inputSchema?: Record<string, unknown>;
  startupDefault?: boolean;
};
export type MediaField = {
  key: string;
  label?: string;
  hint?: string;
  type?: string;
  required?: boolean;
  default?: unknown;
  options?: Array<string | number | boolean>;
  scalar?: boolean;
  maxFiles?: number;
  maxSizeMb?: number;
  accept?: string;
  min?: number;
  max?: number;
  step?: number | string;
  maxLength?: number;
  schema?: { type?: string; enum?: unknown[] } & Record<string, unknown>;
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
  generationStartedAt?: string;
  generationCompletedAt?: string;
  generationDurationMs?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    cached_input_tokens?: number | null;
    reasoning_output_tokens?: number | null;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cachedInputTokens?: number | null;
    reasoningOutputTokens?: number | null;
  };
  projectId?: string | null;
  chatId?: string | null;
};

export type Project = {
  id: string;
  name: string;
  ownerId: string;
  archivedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  chatCount: number;
  materialCount: number;
};

export type Chat = {
  id: string;
  name: string;
  projectId?: string | null;
  mode: 'chat' | 'system';
  context: Record<string, unknown>;
  archivedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  materialCount: number;
};

export type QueueStatus = {
  paused: boolean;
  error: string | null;
  concurrency: number;
};

export type Account = {
  id: string;
  name: string;
  role: 'user' | 'admin';
  identities: Array<{ provider: string; subject: string; email?: string }>;
  wallet: {
    balanceUnits: number;
    heldUnits: number;
    balance: number;
    currency: 'credits';
    scale: number;
  } | null;
};

export type ReleaseInfo = {
  version: string;
  channel: string;
  build: string;
  builtAt?: string | null;
};

export type CodexModel = {
  id: string;
  name: string;
  isDefault?: boolean;
  efforts: string[];
  defaultEffort: string;
  inputModalities?: string[];
};

export type CodexCatalog = {
  models: CodexModel[];
  uiDefaults?: { model?: string; effort?: string; speed?: string; kind?: string };
};
