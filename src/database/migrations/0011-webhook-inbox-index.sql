CREATE INDEX IF NOT EXISTS payment_webhook_inbox_pending
  ON payment_webhook_inbox(provider_id,provider_account_id,environment,created_at)
  WHERE processed_at IS NULL;
