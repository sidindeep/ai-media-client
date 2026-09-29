CREATE TABLE media_parameter_conversion_configs (
  id text PRIMARY KEY,
  source_version text NOT NULL,
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  is_current boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz
);
CREATE UNIQUE INDEX media_parameter_conversion_configs_one_current
  ON media_parameter_conversion_configs (is_current) WHERE is_current;
