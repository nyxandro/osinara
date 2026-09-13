ALTER TABLE agent_schedule_runs ADD COLUMN recovery_protocol integer NOT NULL DEFAULT 0 CHECK(recovery_protocol IN(0,1)),
  ADD COLUMN eve_turn_id text;
