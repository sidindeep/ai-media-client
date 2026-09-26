-- AI Media Client structural reference for src/database/schema.sql (v9).
-- PostgreSQL-only notifications and partial indexes are not represented here.
-- MySQL 8.0.16+; run in an empty UTF-8 database. Timestamps are stored as UTC DATETIME(6).
-- This is a structural reference. The application uses PostgreSQL only.
SET time_zone = '+00:00';

CREATE TABLE media_schema_versions (
  version INT PRIMARY KEY,
  applied_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
);
CREATE TABLE media_accounts (
  id CHAR(36) PRIMARY KEY,
  display_name TEXT NOT NULL,
  role VARCHAR(16) NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
);
CREATE TABLE media_identities (
  provider VARCHAR(64) NOT NULL,
  subject VARCHAR(255) NOT NULL,
  account_id CHAR(36) NOT NULL,
  verified_email TEXT,
  PRIMARY KEY(provider,subject),
  FOREIGN KEY(account_id) REFERENCES media_accounts(id)
);
CREATE TABLE media_sessions (
  token_hash CHAR(64) PRIMARY KEY,
  account_id CHAR(36) NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  INDEX media_sessions_expiry (expires_at),
  FOREIGN KEY(account_id) REFERENCES media_accounts(id)
);
CREATE TABLE media_oauth_flows (
  state_hash CHAR(64) PRIMARY KEY,
  browser_hash CHAR(64) NOT NULL,
  provider VARCHAR(64) NOT NULL,
  verifier TEXT NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  INDEX media_oauth_expiry (expires_at)
);
CREATE TABLE media_wallets (
  account_id CHAR(36) PRIMARY KEY,
  balance BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0 AND balance <= 9007199254740991),
  held BIGINT NOT NULL DEFAULT 0 CHECK (held >= 0),
  CHECK (held <= balance),
  FOREIGN KEY(account_id) REFERENCES media_accounts(id)
);
CREATE TABLE media_records (
  account_id CHAR(36) NOT NULL,
  namespace VARCHAR(64) NOT NULL,
  id VARCHAR(255) NOT NULL,
  data JSON NOT NULL,
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  history_request_id VARCHAR(512) GENERATED ALWAYS AS
    (CASE WHEN namespace = 'history' THEN JSON_UNQUOTE(JSON_EXTRACT(data, '$.requestId')) ELSE NULL END) STORED,
  PRIMARY KEY(account_id,namespace,id),
  INDEX media_records_recent (account_id,namespace,updated_at DESC),
  INDEX media_records_account_record (account_id,id),
  UNIQUE INDEX media_request_once (account_id,history_request_id),
  FOREIGN KEY(account_id) REFERENCES media_accounts(id)
);
CREATE TABLE media_kie_submissions (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  account_id CHAR(36) NOT NULL,
  job_id VARCHAR(255) NOT NULL,
  request_id TEXT,
  kie_account_id TEXT NOT NULL,
  project_id TEXT,
  chat_id TEXT,
  model_id TEXT,
  started_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  finished_at DATETIME(6),
  outcome VARCHAR(16) NOT NULL CHECK (outcome IN ('pending','accepted','rejected','unknown')),
  provider_task_id TEXT,
  error_code TEXT,
  error_message TEXT,
  INDEX media_kie_submissions_recent (started_at DESC,id DESC),
  INDEX media_kie_submissions_job (account_id,job_id,id DESC),
  FOREIGN KEY(account_id) REFERENCES media_accounts(id)
);
CREATE TABLE media_reservations (
  job_id VARCHAR(255) PRIMARY KEY,
  account_id CHAR(36) NOT NULL,
  amount BIGINT NOT NULL CHECK (amount > 0),
  price_version TEXT NOT NULL,
  state VARCHAR(16) NOT NULL CHECK (state IN ('held','captured','released')),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  FOREIGN KEY(account_id) REFERENCES media_accounts(id)
);
CREATE TABLE media_ledger (
  id CHAR(36) PRIMARY KEY,
  account_id CHAR(36) NOT NULL,
  kind VARCHAR(16) NOT NULL CHECK (kind IN ('grant','purchase','reserve','capture','release')),
  reference VARCHAR(512) NOT NULL,
  amount BIGINT NOT NULL CHECK (amount > 0),
  actor_id CHAR(36),
  note TEXT NOT NULL DEFAULT (''),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  details JSON NOT NULL DEFAULT (JSON_OBJECT()),
  UNIQUE KEY media_ledger_once (account_id,kind,reference),
  INDEX media_ledger_recent (account_id,created_at DESC),
  FOREIGN KEY(account_id) REFERENCES media_accounts(id),
  FOREIGN KEY(actor_id) REFERENCES media_accounts(id)
);
CREATE TABLE media_reconciliations (
  job_id VARCHAR(255) PRIMARY KEY,
  account_id CHAR(36) NOT NULL,
  actor_id CHAR(36) NOT NULL,
  outcome VARCHAR(16) NOT NULL CHECK (outcome IN ('success','fail')),
  evidence TEXT NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  FOREIGN KEY(account_id) REFERENCES media_accounts(id),
  FOREIGN KEY(actor_id) REFERENCES media_accounts(id)
);
CREATE TABLE media_admin_invitations (
  email VARCHAR(255) PRIMARY KEY,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  consumed_by CHAR(36),
  consumed_at DATETIME(6),
  FOREIGN KEY(consumed_by) REFERENCES media_accounts(id)
);
CREATE TABLE media_role_audit (
  id CHAR(36) PRIMARY KEY,
  account_id CHAR(36) NOT NULL,
  actor_id CHAR(36),
  old_role TEXT NOT NULL,
  new_role TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  FOREIGN KEY(account_id) REFERENCES media_accounts(id),
  FOREIGN KEY(actor_id) REFERENCES media_accounts(id)
);
CREATE TABLE media_projects (
  id CHAR(36) PRIMARY KEY,
  account_id CHAR(36) NOT NULL,
  owner_id CHAR(36) NOT NULL,
  name TEXT NOT NULL CHECK (CHAR_LENGTH(name) BETWEEN 1 AND 200),
  archived_at DATETIME(6),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  INDEX media_projects_account_recent (account_id,archived_at,updated_at DESC),
  FOREIGN KEY(account_id) REFERENCES media_accounts(id),
  FOREIGN KEY(owner_id) REFERENCES media_accounts(id)
);
CREATE TABLE media_chats (
  id CHAR(36) PRIMARY KEY,
  account_id CHAR(36) NOT NULL,
  project_id CHAR(36),
  name TEXT NOT NULL CHECK (CHAR_LENGTH(name) BETWEEN 1 AND 200),
  mode VARCHAR(16) NOT NULL DEFAULT 'chat' CHECK (mode IN ('chat','system')),
  context JSON NOT NULL DEFAULT (JSON_OBJECT()),
  archived_at DATETIME(6),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  INDEX media_chats_account_recent (account_id,archived_at,updated_at DESC),
  INDEX media_chats_project_recent (account_id,project_id,updated_at DESC),
  FOREIGN KEY(account_id) REFERENCES media_accounts(id),
  FOREIGN KEY(project_id) REFERENCES media_projects(id)
);
CREATE TABLE content_assets (
  account_id CHAR(36) NOT NULL,
  id CHAR(36) NOT NULL,
  storage_key VARCHAR(512) NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT CHECK (size_bytes IS NULL OR size_bytes >= 0),
  sha256 CHAR(64) CHECK (sha256 IS NULL OR REGEXP_LIKE(sha256, '^[a-f0-9]{64}$', 'c')),
  status VARCHAR(16) NOT NULL CHECK (status IN ('saving','ready','failed','missing')),
  origin JSON NOT NULL DEFAULT (JSON_OBJECT()),
  error TEXT,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY(account_id,id),
  INDEX content_assets_account_recent (account_id,created_at DESC),
  INDEX content_assets_status (status,updated_at),
  FOREIGN KEY(account_id) REFERENCES media_accounts(id)
);
CREATE TABLE content_links (
  account_id CHAR(36) NOT NULL,
  namespace VARCHAR(64) NOT NULL,
  record_id VARCHAR(255) NOT NULL,
  asset_id CHAR(36) NOT NULL,
  role VARCHAR(16) NOT NULL CHECK (role IN ('source','result')),
  position INT NOT NULL CHECK (position >= 0),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY(account_id,namespace,record_id,role,position),
  INDEX content_links_asset (account_id,asset_id),
  FOREIGN KEY(account_id,namespace,record_id) REFERENCES media_records(account_id,namespace,id) ON DELETE CASCADE,
  FOREIGN KEY(account_id,asset_id) REFERENCES content_assets(account_id,id)
);
CREATE TABLE content_jobs (
  id CHAR(36) PRIMARY KEY,
  account_id CHAR(36) NOT NULL,
  asset_id CHAR(36) NOT NULL,
  state VARCHAR(16) NOT NULL CHECK (state IN ('pending','processing','retry','done','failed')),
  source JSON NOT NULL,
  attempts INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  locked_at DATETIME(6),
  locked_by TEXT,
  last_error TEXT,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE KEY content_jobs_asset (account_id,asset_id),
  INDEX content_jobs_ready (state,next_attempt_at),
  FOREIGN KEY(account_id,asset_id) REFERENCES content_assets(account_id,id) ON DELETE CASCADE
);

-- Payment tables intentionally have no foreign keys to media_* tables.
CREATE TABLE payment_payments (
  id CHAR(36) PRIMARY KEY,
  client_id VARCHAR(128) NOT NULL,
  environment VARCHAR(8) NOT NULL CHECK (environment IN ('test','live')),
  external_order_id VARCHAR(255) NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 9007199254740991),
  currency CHAR(3) NOT NULL CHECK (REGEXP_LIKE(currency, '^[A-Z]{3}$', 'c')),
  status VARCHAR(16) NOT NULL CHECK (status IN ('created','pending','succeeded','canceled','failed')),
  resolution VARCHAR(16) NOT NULL CHECK (resolution IN ('known','unknown')),
  confirmation_url TEXT,
  expires_at DATETIME(6),
  refunded_minor BIGINT NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE KEY payment_payments_order (client_id,environment,external_order_id),
  CHECK (refunded_minor <= amount_minor)
);
CREATE TABLE payment_commands (
  id CHAR(36) PRIMARY KEY,
  operation VARCHAR(64) NOT NULL,
  client_id VARCHAR(128) NOT NULL,
  environment VARCHAR(8) NOT NULL CHECK (environment IN ('test','live')),
  idempotency_key VARCHAR(255) NOT NULL,
  payload_hash CHAR(64) NOT NULL CHECK (REGEXP_LIKE(payload_hash, '^[a-f0-9]{64}$', 'c')),
  payment_id CHAR(36) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE KEY payment_commands_once (operation,client_id,environment,idempotency_key),
  FOREIGN KEY(payment_id) REFERENCES payment_payments(id)
);
CREATE TABLE payment_attempts (
  id CHAR(36) PRIMARY KEY,
  payment_id CHAR(36) NOT NULL UNIQUE,
  provider_id VARCHAR(64) NOT NULL,
  provider_account_id VARCHAR(128) NOT NULL,
  environment VARCHAR(8) NOT NULL CHECK (environment IN ('test','live')),
  provider_payment_id VARCHAR(255),
  provider_idempotency_key TEXT NOT NULL,
  state VARCHAR(16) NOT NULL CHECK (state IN ('created','pending','succeeded','canceled','failed')),
  resolution VARCHAR(16) NOT NULL CHECK (resolution IN ('known','unknown')),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE KEY payment_attempts_provider_payment (provider_id,provider_account_id,environment,provider_payment_id),
  FOREIGN KEY(payment_id) REFERENCES payment_payments(id)
);
CREATE TABLE payment_webhook_inbox (
  provider_id VARCHAR(64) NOT NULL,
  provider_account_id VARCHAR(128) NOT NULL,
  environment VARCHAR(8) NOT NULL,
  event_identity VARCHAR(255) NOT NULL,
  payload_hash CHAR(64) NOT NULL CHECK (REGEXP_LIKE(payload_hash, '^[a-f0-9]{64}$', 'c')),
  payload JSON NOT NULL,
  processed_at DATETIME(6),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY(provider_id,provider_account_id,environment,event_identity)
);
CREATE TABLE payment_outbox (
  event_id CHAR(36) PRIMARY KEY,
  client_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  aggregate_id CHAR(36) NOT NULL,
  revision BIGINT NOT NULL,
  type VARCHAR(64) NOT NULL,
  payload JSON NOT NULL,
  attempts INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  lease_token CHAR(36),
  leased_until DATETIME(6),
  delivered_at DATETIME(6),
  last_error TEXT,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE KEY payment_outbox_revision (aggregate_id,revision,type),
  INDEX payment_outbox_ready (delivered_at,next_attempt_at),
  FOREIGN KEY(aggregate_id) REFERENCES payment_payments(id)
);
CREATE TABLE media_orders (
  id CHAR(36) PRIMARY KEY,
  account_id CHAR(36) NOT NULL,
  status VARCHAR(32) NOT NULL CHECK (status IN ('awaiting_payment','paid_pending_fulfillment','fulfilled','payment_failed','refund_pending','refunded','review_required')),
  product_id TEXT NOT NULL,
  product_version TEXT NOT NULL,
  offer_snapshot JSON NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 9007199254740991),
  currency CHAR(3) NOT NULL CHECK (REGEXP_LIKE(currency, '^[A-Z]{3}$', 'c')),
  credit_units BIGINT NOT NULL CHECK (credit_units > 0 AND credit_units <= 9007199254740991),
  checkout_key VARCHAR(512) NOT NULL,
  checkout_hash CHAR(64) NOT NULL CHECK (REGEXP_LIKE(checkout_hash, '^[a-f0-9]{64}$', 'c')),
  payment_id CHAR(36),
  confirmation_url TEXT,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE KEY media_orders_checkout (account_id,checkout_key),
  UNIQUE KEY media_orders_payment (payment_id),
  INDEX media_orders_account_recent (account_id,created_at DESC),
  FOREIGN KEY(account_id) REFERENCES media_accounts(id)
);
CREATE TABLE media_payment_inbox (
  producer VARCHAR(128) NOT NULL,
  environment VARCHAR(8) NOT NULL,
  event_id CHAR(36) NOT NULL,
  payload_hash CHAR(64) NOT NULL CHECK (REGEXP_LIKE(payload_hash, '^[a-f0-9]{64}$', 'c')),
  order_id CHAR(36) NOT NULL,
  payload JSON NOT NULL,
  processed_at DATETIME(6),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY(producer,environment,event_id),
  FOREIGN KEY(order_id) REFERENCES media_orders(id)
);
CREATE TABLE media_order_fulfillments (
  order_id CHAR(36) PRIMARY KEY,
  producer VARCHAR(128) NOT NULL,
  environment VARCHAR(8) NOT NULL,
  payment_id CHAR(36) NOT NULL,
  account_id CHAR(36) NOT NULL,
  credit_units BIGINT NOT NULL CHECK (credit_units > 0),
  ledger_reference VARCHAR(512) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE KEY media_order_fulfillments_payment (producer,environment,payment_id),
  UNIQUE KEY media_order_fulfillments_reference (ledger_reference),
  FOREIGN KEY(order_id) REFERENCES media_orders(id),
  FOREIGN KEY(account_id) REFERENCES media_accounts(id)
);
CREATE TABLE media_telegram_links (
  telegram_user_id VARCHAR(20) PRIMARY KEY CHECK (REGEXP_LIKE(telegram_user_id, '^[0-9]{1,20}$', 'c')),
  account_id CHAR(36) NOT NULL UNIQUE,
  username TEXT,
  linked_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  FOREIGN KEY(account_id) REFERENCES media_accounts(id) ON DELETE CASCADE
);
CREATE TABLE media_telegram_link_flows (
  token_hash CHAR(64) PRIMARY KEY CHECK (REGEXP_LIKE(token_hash, '^[a-f0-9]{64}$', 'c')),
  account_id CHAR(36) NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  telegram_user_id VARCHAR(20),
  consumed_at DATETIME(6),
  CHECK (telegram_user_id IS NULL OR REGEXP_LIKE(telegram_user_id, '^[0-9]{1,20}$', 'c')),
  INDEX media_telegram_link_flows_account (account_id),
  INDEX media_telegram_link_flows_expiry (expires_at),
  FOREIGN KEY(account_id) REFERENCES media_accounts(id) ON DELETE CASCADE
);
CREATE TABLE media_file_deletions (
  id CHAR(36) PRIMARY KEY,
  account_id CHAR(36) NOT NULL,
  kind VARCHAR(16) NOT NULL CHECK (kind IN ('object','local')),
  locator VARCHAR(512) NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  next_attempt_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE KEY media_file_deletions_once (account_id,kind,locator),
  INDEX media_file_deletions_due (next_attempt_at,created_at),
  FOREIGN KEY(account_id) REFERENCES media_accounts(id) ON DELETE CASCADE
);
CREATE TABLE media_deleted_chat_records (
  account_id CHAR(36) NOT NULL,
  namespace VARCHAR(64) NOT NULL,
  id VARCHAR(255) NOT NULL,
  chat_id CHAR(36) NOT NULL,
  deleted_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY(account_id,namespace,id),
  FOREIGN KEY(account_id) REFERENCES media_accounts(id) ON DELETE CASCADE
);

INSERT INTO media_schema_versions(version) VALUES (1),(2),(3),(4),(5),(6),(7),(8),(9);
