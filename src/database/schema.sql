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
