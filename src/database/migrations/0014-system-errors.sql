CREATE TABLE media_system_errors (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL,
  event text NOT NULL,
  code text,
  message text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX media_system_errors_recent ON media_system_errors(occurred_at DESC,id DESC);
