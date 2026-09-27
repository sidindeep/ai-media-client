ALTER TABLE payment_commands ADD COLUMN IF NOT EXISTS request_payload jsonb;
ALTER TABLE payment_commands ADD COLUMN IF NOT EXISTS lease_token uuid;
ALTER TABLE payment_commands ADD COLUMN IF NOT EXISTS leased_until timestamptz;
ALTER TABLE payment_commands ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS payment_commands_recovery ON payment_commands(next_attempt_at,created_at)
  WHERE operation='create' AND request_payload IS NOT NULL;
