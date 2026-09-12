ALTER TYPE reminder_recurrence_unit ADD VALUE 'minutely';
ALTER TYPE reminder_recurrence_unit ADD VALUE 'hourly';
ALTER TYPE reminder_recurrence_unit ADD VALUE 'yearly';
ALTER TYPE agent_schedule_recurrence_kind ADD VALUE 'minutely';
ALTER TYPE agent_schedule_recurrence_kind ADD VALUE 'hourly';
ALTER TYPE agent_schedule_recurrence_kind ADD VALUE 'monthly';
ALTER TYPE agent_schedule_recurrence_kind ADD VALUE 'yearly';

-- A local timestamp cannot distinguish the two occurrences of an autumn DST hour.
-- Only new fixed-duration recurrences require this exact instant. Existing calendar anchors
-- remain authoritative and need no reconstruction or change to their next scheduled time.
ALTER TABLE reminders ADD COLUMN recurrence_anchor_at timestamptz;
ALTER TABLE agent_schedules ADD COLUMN recurrence_anchor_at timestamptz;

-- Compare as text: newly added enum labels cannot be used as enum values until this file commits.
ALTER TABLE reminders ADD CONSTRAINT reminders_fixed_recurrence_anchor_check CHECK (
  recurrence_unit::text NOT IN ('minutely', 'hourly') OR recurrence_anchor_at IS NOT NULL
);
ALTER TABLE agent_schedules ADD CONSTRAINT agent_schedules_fixed_recurrence_anchor_check CHECK (
  recurrence_kind::text NOT IN ('minutely', 'hourly') OR recurrence_anchor_at IS NOT NULL
);
