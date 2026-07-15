ALTER TABLE IF EXISTS scheduled_task_operations RENAME COLUMN scheduled_task_id TO reminder_id;
ALTER TABLE IF EXISTS scheduled_task_operations RENAME TO reminder_operations;
ALTER TABLE IF EXISTS scheduled_tasks RENAME TO reminders;

ALTER INDEX IF EXISTS scheduled_tasks_due_idx RENAME TO reminders_due_idx;
ALTER INDEX IF EXISTS scheduled_tasks_family_owner_idx RENAME TO reminders_family_owner_idx;
ALTER INDEX IF EXISTS scheduled_tasks_family_group_idx RENAME TO reminders_family_group_idx;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'scheduled_task_scope')
     AND NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'reminder_scope') THEN
    ALTER TYPE scheduled_task_scope RENAME TO reminder_scope;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'scheduled_task_status')
     AND NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'reminder_status') THEN
    ALTER TYPE scheduled_task_status RENAME TO reminder_status;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'scheduled_task_recurrence_unit')
     AND NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'reminder_recurrence_unit') THEN
    ALTER TYPE scheduled_task_recurrence_unit RENAME TO reminder_recurrence_unit;
  END IF;
END $$;

DROP TABLE IF EXISTS family_task_operations;
DROP TABLE IF EXISTS family_tasks;

DROP TYPE IF EXISTS family_task_status;
DROP TYPE IF EXISTS family_task_scope;
