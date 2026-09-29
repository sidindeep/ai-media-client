ALTER TABLE media_service_model_configs
  ADD COLUMN variant text NOT NULL DEFAULT 'all' CHECK (variant IN ('all', 'shared')),
  ADD COLUMN title text NOT NULL DEFAULT 'Наш сервис 1',
  ADD COLUMN base_version text;
