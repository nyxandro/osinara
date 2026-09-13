-- NULL keeps the existing unbounded recurrence contract. Counts belong to delivered runs,
-- not calendar occurrence_index (missed calendar ticks are intentionally skipped).
ALTER TABLE agent_schedules
  ADD COLUMN max_runs integer CHECK (max_runs > 0),
  ADD COLUMN completed_runs integer NOT NULL DEFAULT 0 CHECK (completed_runs >= 0),
  ADD COLUMN pause_requested boolean NOT NULL DEFAULT false;

UPDATE agent_schedules schedule
SET completed_runs = (
  SELECT count(*) FROM agent_schedule_runs run
  WHERE run.schedule_id = schedule.id AND run.status = 'completed'
    AND EXISTS (SELECT 1 FROM proactive_deliveries delivery
      WHERE delivery.source_kind = 'agent_schedule' AND delivery.source_id = run.id)
);

ALTER TABLE agent_schedules
  ADD CONSTRAINT agent_schedule_limit_valid CHECK (max_runs IS NULL OR completed_runs <= max_runs),
  ADD CONSTRAINT agent_schedule_once_limit_valid CHECK (recurrence_kind <> 'once' OR max_runs IS NULL OR max_runs = 1);
