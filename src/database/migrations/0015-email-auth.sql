CREATE TABLE media_email_pending (
  email text PRIMARY KEY,
  password_hash text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_email_pending_expiry ON media_email_pending(expires_at);

CREATE TABLE media_email_credentials (
  email text PRIMARY KEY,
  account_id uuid NOT NULL UNIQUE REFERENCES media_accounts(id),
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE media_email_resets (
  token_hash text PRIMARY KEY,
  email text NOT NULL UNIQUE REFERENCES media_email_credentials(email),
  expires_at timestamptz NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_email_resets_expiry ON media_email_resets(expires_at);
