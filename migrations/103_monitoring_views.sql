-- Aggregate-only projections for external monitoring, plus the read-only role that reads them.
--
-- The exporter runs outside the application and must never reach user content. Views are created
-- by the migration owner and execute with its privileges, so granting SELECT on the views alone
-- lets the role read counts and ages while every base table stays closed to it.
--
-- Everything here is created in the current schema, like every other migration, so an upgrade
-- replayed into an isolated schema stays isolated. Each view is granted explicitly: a blanket
-- grant on the schema would also hand the role every future table in it.

-- Roles live in the cluster, not the database, so a restored or recreated database can meet an
-- existing role. Reusing one blindly would be the whole boundary undone: an osinara_metrics that
-- someone had made a superuser, or a member of pg_read_all_data, would read every table the moment
-- the operator grants it a password. An unexpected role therefore stops the migration.
-- NOLOGIN is deliberate: the password is granted once by the operator on the server, and LOGIN on
-- an existing role is expected rather than suspicious.
DO $$
DECLARE
  unsafe text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'osinara_metrics') THEN
    CREATE ROLE osinara_metrics NOLOGIN;
    RETURN;
  END IF;

  SELECT string_agg(finding, ', ' ORDER BY finding) INTO unsafe FROM (
    SELECT 'SUPERUSER'   AS finding FROM pg_roles WHERE rolname = 'osinara_metrics' AND rolsuper
    UNION ALL SELECT 'CREATEROLE'   FROM pg_roles WHERE rolname = 'osinara_metrics' AND rolcreaterole
    UNION ALL SELECT 'CREATEDB'     FROM pg_roles WHERE rolname = 'osinara_metrics' AND rolcreatedb
    UNION ALL SELECT 'REPLICATION'  FROM pg_roles WHERE rolname = 'osinara_metrics' AND rolreplication
    UNION ALL SELECT 'BYPASSRLS'    FROM pg_roles WHERE rolname = 'osinara_metrics' AND rolbypassrls
    UNION ALL SELECT 'membership in ' || granted.rolname
      FROM pg_auth_members membership
      JOIN pg_roles member ON member.oid = membership.member AND member.rolname = 'osinara_metrics'
      JOIN pg_roles granted ON granted.oid = membership.roleid
  ) AS findings;

  IF unsafe IS NOT NULL THEN
    RAISE EXCEPTION 'AGENT_METRICS_ROLE_UNSAFE: existing role osinara_metrics carries privileges beyond reading monitoring views (%)', unsafe;
  END IF;
END $$;

-- How long the oldest unprocessed message has been waiting is the one number that tells whether
-- the family is being answered at all.
CREATE VIEW monitoring_telegram_ingress AS
  SELECT
    count(*) FILTER (WHERE status = 'pending')    AS pending,
    count(*) FILTER (WHERE status = 'processing') AS processing,
    count(*) FILTER (WHERE status = 'failed')     AS failed,
    coalesce(
      extract(epoch FROM now() - min(received_at) FILTER (WHERE status = 'pending')),
      0
    ) AS oldest_pending_age_seconds
  FROM telegram_ingress_updates;

-- Diagnostics the application owes the owner. Anything stuck in pending means that channel is mute.
CREATE VIEW monitoring_operational_incidents AS
  SELECT status, count(*) AS total
  FROM operational_incidents
  GROUP BY status;

-- `recent` is what alerts on: a batch that failed once stays in the table until an operator
-- resolves it, so an all-time count would latch an alert on forever and destroy the difference
-- between "something is wrong now" and "something went wrong once".
CREATE VIEW monitoring_memory_review_batches AS
  SELECT
    status::text AS status,
    count(*) AS total,
    count(*) FILTER (WHERE updated_at > now() - interval '24 hours') AS recent
  FROM memory_review_batches
  GROUP BY status;

CREATE VIEW monitoring_memory_embedding_jobs AS
  SELECT
    status::text AS status,
    count(*) AS total,
    count(*) FILTER (WHERE updated_at > now() - interval '24 hours') AS recent
  FROM memory_embedding_jobs
  GROUP BY status;

-- route_key is already a hash of the model route, so it identifies a route without naming it.
CREATE VIEW monitoring_model_availability AS
  SELECT route_key, extract(epoch FROM now() - observed_at) AS last_success_age_seconds
  FROM model_availability;

CREATE VIEW monitoring_runtime_maintenance AS
  SELECT phase, extract(epoch FROM now() - updated_at) AS age_seconds
  FROM runtime_maintenance;

CREATE VIEW monitoring_agent_schedule_runs AS
  SELECT status::text AS status, count(*) AS total
  FROM agent_schedule_runs
  WHERE created_at > now() - interval '24 hours'
  GROUP BY status;

GRANT SELECT ON monitoring_telegram_ingress       TO osinara_metrics;
GRANT SELECT ON monitoring_operational_incidents  TO osinara_metrics;
GRANT SELECT ON monitoring_memory_review_batches  TO osinara_metrics;
GRANT SELECT ON monitoring_memory_embedding_jobs  TO osinara_metrics;
GRANT SELECT ON monitoring_model_availability     TO osinara_metrics;
GRANT SELECT ON monitoring_runtime_maintenance    TO osinara_metrics;
GRANT SELECT ON monitoring_agent_schedule_runs    TO osinara_metrics;
