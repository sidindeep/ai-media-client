CREATE TABLE IF NOT EXISTS media_schema_versions (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS media_accounts (
  id uuid PRIMARY KEY, display_name text NOT NULL,
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS media_identities (
  provider text NOT NULL, subject text NOT NULL, account_id uuid NOT NULL REFERENCES media_accounts(id),
  PRIMARY KEY(provider,subject)
);
CREATE TABLE IF NOT EXISTS media_sessions (
  token_hash text PRIMARY KEY, account_id uuid NOT NULL REFERENCES media_accounts(id), expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS media_sessions_expiry ON media_sessions(expires_at);
CREATE TABLE IF NOT EXISTS media_oauth_flows (
  state_hash text PRIMARY KEY, browser_hash text NOT NULL, provider text NOT NULL,
  verifier text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS media_oauth_expiry ON media_oauth_flows(expires_at);
CREATE TABLE IF NOT EXISTS media_wallets (
  account_id uuid PRIMARY KEY REFERENCES media_accounts(id),
  balance bigint NOT NULL DEFAULT 0 CHECK (balance >= 0 AND balance <= 9007199254740991),
  held bigint NOT NULL DEFAULT 0 CHECK (held >= 0 AND held <= balance)
);
CREATE TABLE IF NOT EXISTS media_records (
  account_id uuid NOT NULL REFERENCES media_accounts(id), namespace text NOT NULL,
  id text NOT NULL, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(account_id,namespace,id)
);
CREATE INDEX IF NOT EXISTS media_records_recent ON media_records(account_id,namespace,updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS media_request_once ON media_records(account_id,(data->>'requestId'))
  WHERE namespace='history' AND data->>'requestId' IS NOT NULL;
CREATE TABLE IF NOT EXISTS media_kie_submissions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES media_accounts(id),
  job_id text NOT NULL,
  request_id text,
  kie_account_id text NOT NULL,
  project_id text,
  chat_id text,
  model_id text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  outcome text NOT NULL CHECK (outcome IN ('pending','accepted','rejected','unknown')),
  provider_task_id text,
  error_code text,
  error_message text
);
CREATE INDEX IF NOT EXISTS media_kie_submissions_recent ON media_kie_submissions(started_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS media_kie_submissions_job ON media_kie_submissions(account_id,job_id,id DESC);
CREATE TABLE IF NOT EXISTS media_reservations (
  job_id text PRIMARY KEY, account_id uuid NOT NULL REFERENCES media_accounts(id),
  amount bigint NOT NULL CHECK (amount > 0), price_version text NOT NULL,
  state text NOT NULL CHECK (state IN ('held','captured','released')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS media_ledger (
  id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES media_accounts(id),
  kind text NOT NULL CHECK (kind IN ('grant','purchase','reserve','capture','release')),
  reference text NOT NULL, amount bigint NOT NULL CHECK (amount > 0),
  actor_id uuid REFERENCES media_accounts(id), note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(account_id,kind,reference)
);
CREATE INDEX IF NOT EXISTS media_ledger_recent ON media_ledger(account_id,created_at DESC);
CREATE TABLE IF NOT EXISTS media_reconciliations (
  job_id text PRIMARY KEY, account_id uuid NOT NULL REFERENCES media_accounts(id),
  actor_id uuid NOT NULL REFERENCES media_accounts(id), outcome text NOT NULL CHECK(outcome IN ('success','fail')),
  evidence text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO media_schema_versions(version) VALUES (1) ON CONFLICT DO NOTHING;
ALTER TABLE media_identities ADD COLUMN IF NOT EXISTS verified_email text;
CREATE TABLE IF NOT EXISTS media_admin_invitations (
  email text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(),
  consumed_by uuid REFERENCES media_accounts(id), consumed_at timestamptz
);
CREATE TABLE IF NOT EXISTS media_role_audit (
  id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES media_accounts(id),
  actor_id uuid REFERENCES media_accounts(id), old_role text NOT NULL, new_role text NOT NULL,
  reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO media_schema_versions(version) VALUES (2) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS media_projects (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES media_accounts(id),
  owner_id uuid NOT NULL REFERENCES media_accounts(id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS media_projects_account_recent ON media_projects(account_id, archived_at, updated_at DESC);

CREATE TABLE IF NOT EXISTS media_chats (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES media_accounts(id),
  project_id uuid REFERENCES media_projects(id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  mode text NOT NULL DEFAULT 'chat' CHECK (mode IN ('chat', 'system')),
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS media_chats_account_recent ON media_chats(account_id, archived_at, updated_at DESC);
CREATE INDEX IF NOT EXISTS media_chats_project_recent ON media_chats(account_id, project_id, updated_at DESC);

INSERT INTO media_schema_versions(version) VALUES (3) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS content_assets (
  account_id uuid NOT NULL REFERENCES media_accounts(id),
  id uuid NOT NULL,
  storage_key text NOT NULL UNIQUE,
  original_name text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('saving','ready','failed','missing')),
  origin jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(account_id,id)
);
CREATE INDEX IF NOT EXISTS content_assets_account_recent ON content_assets(account_id,created_at DESC);
CREATE INDEX IF NOT EXISTS content_assets_status ON content_assets(status,updated_at);

CREATE TABLE IF NOT EXISTS content_links (
  account_id uuid NOT NULL,
  namespace text NOT NULL,
  record_id text NOT NULL,
  asset_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('source','result')),
  position integer NOT NULL CHECK (position >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(account_id,namespace,record_id,role,position),
  FOREIGN KEY(account_id,namespace,record_id) REFERENCES media_records(account_id,namespace,id) ON DELETE CASCADE,
  FOREIGN KEY(account_id,asset_id) REFERENCES content_assets(account_id,id)
);
CREATE INDEX IF NOT EXISTS content_links_asset ON content_links(account_id,asset_id);

CREATE TABLE IF NOT EXISTS content_jobs (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','processing','retry','done','failed')),
  source jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id,asset_id),
  FOREIGN KEY(account_id,asset_id) REFERENCES content_assets(account_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS content_jobs_ready ON content_jobs(state,next_attempt_at);

INSERT INTO media_schema_versions(version) VALUES (4) ON CONFLICT DO NOTHING;

-- Payment bounded context. It deliberately has no foreign keys to media_* tables.
CREATE TABLE IF NOT EXISTS payment_payments (
  id uuid PRIMARY KEY,
  client_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('test','live')),
  external_order_id text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 9007199254740991),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL CHECK (status IN ('created','pending','succeeded','canceled','failed')),
  resolution text NOT NULL CHECK (resolution IN ('known','unknown')),
  confirmation_url text,
  expires_at timestamptz,
  refunded_minor bigint NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0 AND refunded_minor <= amount_minor),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(client_id,environment,external_order_id)
);
CREATE TABLE IF NOT EXISTS payment_commands (
  id uuid PRIMARY KEY,
  operation text NOT NULL,
  client_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('test','live')),
  idempotency_key text NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  payment_id uuid NOT NULL REFERENCES payment_payments(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(operation,client_id,environment,idempotency_key)
);
CREATE TABLE IF NOT EXISTS payment_attempts (
  id uuid PRIMARY KEY,
  payment_id uuid NOT NULL UNIQUE REFERENCES payment_payments(id),
  provider_id text NOT NULL,
  provider_account_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('test','live')),
  provider_payment_id text,
  provider_idempotency_key text NOT NULL,
  state text NOT NULL CHECK (state IN ('created','pending','succeeded','canceled','failed')),
  resolution text NOT NULL CHECK (resolution IN ('known','unknown')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_provider_payment ON payment_attempts(provider_id,provider_account_id,environment,provider_payment_id) WHERE provider_payment_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS payment_webhook_inbox (
  provider_id text NOT NULL,
  provider_account_id text NOT NULL,
  environment text NOT NULL,
  event_identity text NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(provider_id,provider_account_id,environment,event_identity)
);
CREATE TABLE IF NOT EXISTS payment_outbox (
  event_id uuid PRIMARY KEY,
  client_id text NOT NULL,
  environment text NOT NULL,
  aggregate_id uuid NOT NULL REFERENCES payment_payments(id),
  revision bigint NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  leased_until timestamptz,
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(aggregate_id,revision,type)
);
CREATE INDEX IF NOT EXISTS payment_outbox_ready ON payment_outbox(delivered_at,next_attempt_at);

-- Product commerce owns orders, fulfillment and the consumer inbox.
CREATE TABLE IF NOT EXISTS media_orders (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES media_accounts(id),
  status text NOT NULL CHECK (status IN ('awaiting_payment','paid_pending_fulfillment','fulfilled','payment_failed','refund_pending','refunded','review_required')),
  product_id text NOT NULL,
  product_version text NOT NULL,
  offer_snapshot jsonb NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 9007199254740991),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  credit_units bigint NOT NULL CHECK (credit_units > 0 AND credit_units <= 9007199254740991),
  checkout_key text NOT NULL,
  checkout_hash text NOT NULL CHECK (checkout_hash ~ '^[a-f0-9]{64}$'),
  payment_id uuid,
  confirmation_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id,checkout_key), UNIQUE(payment_id)
);
CREATE INDEX IF NOT EXISTS media_orders_account_recent ON media_orders(account_id,created_at DESC);
CREATE TABLE IF NOT EXISTS media_payment_inbox (
  producer text NOT NULL,
  environment text NOT NULL,
  event_id uuid NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  order_id uuid NOT NULL REFERENCES media_orders(id),
  payload jsonb NOT NULL,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(producer,environment,event_id)
);
CREATE TABLE IF NOT EXISTS media_order_fulfillments (
  order_id uuid PRIMARY KEY REFERENCES media_orders(id),
  producer text NOT NULL,
  environment text NOT NULL,
  payment_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES media_accounts(id),
  credit_units bigint NOT NULL CHECK (credit_units > 0),
  ledger_reference text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(producer,environment,payment_id), UNIQUE(ledger_reference)
);

INSERT INTO media_schema_versions(version) VALUES (5) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS media_telegram_links (
  telegram_user_id text PRIMARY KEY CHECK (telegram_user_id ~ '^[0-9]{1,20}$'),
  account_id uuid NOT NULL UNIQUE REFERENCES media_accounts(id) ON DELETE CASCADE,
  username text,
  linked_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS media_telegram_link_flows (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  account_id uuid NOT NULL REFERENCES media_accounts(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  telegram_user_id text,
  consumed_at timestamptz,
  CHECK (telegram_user_id IS NULL OR telegram_user_id ~ '^[0-9]{1,20}$')
);
CREATE INDEX IF NOT EXISTS media_telegram_link_flows_account ON media_telegram_link_flows(account_id);
CREATE INDEX IF NOT EXISTS media_telegram_link_flows_expiry ON media_telegram_link_flows(expires_at);
INSERT INTO media_schema_versions(version) VALUES (6) ON CONFLICT DO NOTHING;

-- Immutable display details for completed spending operations.
ALTER TABLE media_ledger ADD COLUMN IF NOT EXISTS details jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS media_records_account_record ON media_records(account_id,id);
INSERT INTO media_schema_versions(version) VALUES (7) ON CONFLICT DO NOTHING;
INSERT INTO media_schema_versions(version) VALUES (8) ON CONFLICT DO NOTHING;

-- Files are removed after the chat deletion commits; failed cleanup is retried.
CREATE TABLE IF NOT EXISTS media_file_deletions (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES media_accounts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('object','local')),
  locator text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id,kind,locator)
);
CREATE INDEX IF NOT EXISTS media_file_deletions_due ON media_file_deletions(next_attempt_at,created_at);
CREATE TABLE IF NOT EXISTS media_deleted_chat_records (
  account_id uuid NOT NULL REFERENCES media_accounts(id) ON DELETE CASCADE,
  namespace text NOT NULL,
  id text NOT NULL,
  chat_id uuid NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(account_id,namespace,id)
);
INSERT INTO media_schema_versions(version) VALUES (9) ON CONFLICT DO NOTHING;
