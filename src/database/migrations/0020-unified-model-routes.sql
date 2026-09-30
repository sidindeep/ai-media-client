-- Keep the richest last model snapshot before removing the two retired registries.
CREATE TABLE media_model_routes (
  id text PRIMARY KEY CHECK (id = 'model-routes'),
  source_version text NOT NULL,
  models jsonb NOT NULL CHECK (jsonb_typeof(models) = 'array'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO media_model_routes(id, source_version, models)
SELECT 'model-routes', source_version, models
FROM media_service_model_configs
ORDER BY jsonb_array_length(models) DESC, is_current DESC, created_at DESC
LIMIT 1;
DROP TABLE media_parameter_conversion_configs;
DROP TABLE media_service_model_configs;
