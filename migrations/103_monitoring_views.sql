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
-- existing role. NOLOGIN is deliberate: the password is granted once by the operator on the server.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'osinara_metrics') THEN
    CREATE ROLE osinara_metrics NOLOGIN;
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

CREATE VIEW monitoring_memory_review_batches AS
  SELECT status::text AS status, count(*) AS total
  FROM memory_review_batches
  GROUP BY status;

CREATE VIEW monitoring_memory_embedding_jobs AS
  SELECT status::text AS status, count(*) AS total
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
