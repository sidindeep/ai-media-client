DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM media_records WHERE jsonb_typeof(data)<>'object') THEN
    RAISE EXCEPTION 'Non-object media_records must be repaired before schema v13';
  END IF;
  IF EXISTS (SELECT 1 FROM (
    SELECT account_id,project_id FROM media_chats WHERE mode='system' AND archived_at IS NULL
    GROUP BY account_id,project_id HAVING count(*)>1) duplicates) THEN
    RAISE EXCEPTION 'Duplicate active system chats must be repaired before schema v13';
  END IF;
END $$;
ALTER TABLE media_records ADD CONSTRAINT media_records_data_object CHECK (jsonb_typeof(data)='object');
CREATE UNIQUE INDEX media_chats_active_system_unique ON media_chats(account_id,COALESCE(project_id,'00000000-0000-0000-0000-000000000000'::uuid))
  WHERE mode='system' AND archived_at IS NULL;
CREATE INDEX media_records_account_chat_count ON media_records(account_id,(data->>'chatId'));
CREATE INDEX media_records_account_project_count ON media_records(account_id,(data->>'projectId'));
