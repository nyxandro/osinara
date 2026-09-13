ALTER TABLE runtime_admission_holders ADD COLUMN owner_hostname text, ADD COLUMN owner_pid integer,
  ADD COLUMN owner_start_ticks text;
ALTER TABLE runtime_admission_holders ADD CONSTRAINT runtime_process_identity_complete CHECK (
  (owner_hostname IS NULL AND owner_pid IS NULL AND owner_start_ticks IS NULL) OR
  (owner_hostname IS NOT NULL AND owner_pid>0 AND owner_start_ticks IS NOT NULL)
);
