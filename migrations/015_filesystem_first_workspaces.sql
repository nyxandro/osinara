ALTER TABLE workspace_file_deliveries
  ADD COLUMN file_path text;

UPDATE workspace_file_deliveries AS delivery
   SET file_path = file.path
  FROM workspace_files AS file
 WHERE file.id = delivery.file_id;

ALTER TABLE workspace_file_deliveries
  ALTER COLUMN file_path SET NOT NULL;

DROP INDEX workspace_file_deliveries_file_idx;

ALTER TABLE workspace_file_deliveries
  DROP COLUMN file_id;

CREATE INDEX workspace_file_deliveries_path_idx
  ON workspace_file_deliveries (workspace_id, file_path, created_at DESC);

DROP TABLE workspace_file_derivatives;
DROP TABLE workspace_files;
