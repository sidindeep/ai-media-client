CREATE TABLE media_max_login_flows (
  state_hash text PRIMARY KEY,
  browser_hash text NOT NULL,
  account_id uuid REFERENCES media_accounts(id),
  expires_at timestamptz NOT NULL
);
CREATE INDEX media_max_login_flows_expiry ON media_max_login_flows(expires_at);
