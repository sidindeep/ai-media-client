export type SpendingCategory = 'all' | 'image' | 'video' | 'text' | 'audio' | 'other';
export type SpendingItem = {
  id: string; kind: 'capture' | 'release'; amountUnits: number; createdAt: string;
  category: Exclude<SpendingCategory, 'all'>; modelName: string | null; recordId: string | null;
};
export type SpendingPageData = {
  days: 7 | 30 | 90; category: SpendingCategory; asOf: string;
  summary: { spentUnits: number; releasedUnits: number; topCategory: Exclude<SpendingCategory, 'all'> | null };
  items: SpendingItem[]; nextCursor: string | null;
};

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
  description?: string;
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
  kieAccounts?: Array<{ id: 'primary' | 'secondary'; name: string; configured: boolean }>;
  providers: Array<{ id: string; name: string }>;
  models: MediaModel[];
};

export type GenerationPreset = {
  id: string;
  name: string;
  provider: 'codex' | 'media' | 'routerai';
  mode: 'text' | 'image' | 'video' | 'audio';
  mediaModelId?: string;
  mediaInput?: Record<string, unknown>;
  codexModel?: string;
  routerAiModel?: string;
  codexEffort?: string;
  codexSpeed?: string;
  codexAspectRatio?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type GenerationRecord = {
  contentAssetId?: string;
  providerVideoId?: string;
  kieAccountId?: 'primary' | 'secondary';
  id: string;
  requestId?: string;
  revision?: number;
  optimistic?: boolean;
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
  queuedAt?: string;
  preparingAt?: string;
  submittingAt?: string;
  providerAcceptedAt?: string;
  providerFirstCheckedAt?: string;
  providerStateChangedAt?: string;
  lastCheckedAt?: string;
  resultReceivedAt?: string;
  resultSavedAt?: string;
  progress?: number;
  providerDurationMs?: number;
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

export type WorkspaceSync = {
  cursor: string;
  full: boolean;
  records: GenerationRecord[];
  projects: Project[];
  chats: Chat[];
  queue: QueueStatus;
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
  starterPack?: {
    enabled: boolean;
    enrolled: boolean;
    active: boolean;
    unlockedByPayment: boolean;
    credits: number;
    modelAccess: 'gpt-only' | 'all';
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

export type RouterAiCatalog = { models: Array<{ id: string; name: string; description?: string; kind: 'text' | 'image' | 'video' | 'audio' | 'transcription' | 'embeddings' | 'rerank' | 'decisions'; endpoint?: string }> };
