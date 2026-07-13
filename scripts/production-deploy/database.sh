#!/bin/bash
# PostgreSQL deployment proposal state transitions.
# Reconciles stale leases, atomically claims one exact-owner proposal, and records terminal results.

readonly DEPLOYMENT_LEASE_INTERVAL="60 minutes"

psql_current() {
  compose_current exec -T postgres psql -X --no-psqlrc --set ON_ERROR_STOP=1 \
    --username osinara --dbname osinara --no-align --tuples-only "$@"
}

reconcile_stale_deployments() {
  local stale
  stale="$(psql_current --field-separator=$'\t' <<'SQL'
UPDATE software_update_proposals
   SET status = 'ambiguous',
       result = jsonb_build_object(
         'code', 'DEPLOY_STALE_LEASE_AMBIGUOUS',
         'message', 'Deployment lease expired before a terminal result'
       ),
       result_error_code = 'DEPLOY_STALE_LEASE_AMBIGUOUS',
       result_error_message = 'Deployment lease expired before a terminal result',
       deployment_lease_token = NULL,
       deployment_lease_expires_at = NULL,
       completed_at = now(),
       updated_at = now()
 WHERE status = 'deploying'
   AND deployment_lease_expires_at <= now()
RETURNING id::text, telegram_chat_id, target_version;
SQL
)"
  if [[ -n "$stale" ]]; then
    STALE_DEPLOYMENT_FOUND=1
    local _stale_id
    IFS=$'\t' read -r _stale_id OWNER_CHAT_ID REQUESTED_VERSION <<<"$stale"
    log_event "DEPLOY_STALE_LEASE_AMBIGUOUS" \
      "Expired deploying proposal was marked ambiguous; automatic retry is forbidden"
    send_telegram_notification \
      "Предыдущее обновление v${REQUESTED_VERSION} завершилось неоднозначно после остановки процесса. Код: DEPLOY_STALE_LEASE_AMBIGUOUS"
  fi
}

claim_approved_proposal() {
  read -r LEASE_TOKEN < /proc/sys/kernel/random/uuid
  local claimed
  claimed="$(psql_current --field-separator=$'\t' \
    --set="lease_token=${LEASE_TOKEN}" --set="lease_interval=${DEPLOYMENT_LEASE_INTERVAL}" <<'SQL'
WITH global_owner AS (
  SELECT max(fm.family_id::text)::uuid AS family_id,
         max(fm.user_id::text)::uuid AS user_id,
         max(owner_user.telegram_user_id) AS telegram_user_id
    FROM family_memberships fm
    JOIN users owner_user ON owner_user.id = fm.user_id
   WHERE fm.role = 'owner'
  HAVING count(*) = 1
), candidate AS (
  SELECT proposal.id
    FROM software_update_proposals proposal
    JOIN global_owner owner
      ON owner.family_id = proposal.family_id
     AND owner.user_id = proposal.expected_owner_user_id
     AND owner.telegram_user_id = proposal.expected_owner_telegram_user_id
   WHERE proposal.status = 'approved'
     AND proposal.telegram_chat_type = 'private'
     AND proposal.telegram_chat_id = proposal.expected_owner_telegram_user_id
   ORDER BY proposal.decided_at, proposal.created_at
   FOR UPDATE OF proposal SKIP LOCKED
   LIMIT 1
), claimed AS (
  UPDATE software_update_proposals proposal
     SET status = 'deploying',
         deployment_started_at = now(),
         deployment_lease_token = :'lease_token'::uuid,
         deployment_lease_expires_at = now() + :'lease_interval'::interval,
         updated_at = now()
    FROM candidate
   WHERE proposal.id = candidate.id AND proposal.status = 'approved'
  RETURNING proposal.id::text, proposal.target_version, proposal.telegram_chat_id,
            proposal.manifest->>'version', proposal.manifest->>'commitSha',
            proposal.manifest->>'composeSha256',
            proposal.manifest->'images'->>'app', proposal.manifest->'images'->>'edge',
            proposal.manifest->'images'->>'sandboxEgressProxy',
            proposal.manifest->'images'->>'sandboxRunner',
            proposal.manifest->'images'->>'sandboxRuntime'
)
SELECT * FROM claimed;
SQL
)"
  if [[ -z "$claimed" ]]; then
    LEASE_TOKEN=""
    log_event "DEPLOY_NO_APPROVED_PROPOSAL" "No approved exact-owner update is waiting"
    return 0
  fi

  CLAIM_FOUND=1
  IFS=$'\t' read -r PROPOSAL_ID REQUESTED_VERSION OWNER_CHAT_ID \
    STORED_VERSION STORED_COMMIT STORED_COMPOSE_SHA STORED_APP STORED_EDGE \
    STORED_EGRESS STORED_RUNNER STORED_RUNTIME <<<"$claimed"
  if [[ ! "$PROPOSAL_ID" =~ ^[0-9a-f-]{36}$ || ! "$OWNER_CHAT_ID" =~ ^-?[0-9]+$ ]]; then
    fail "DEPLOY_PROPOSAL_INVALID" "Claimed proposal has invalid identity fields"
  fi
  require_semver "$REQUESTED_VERSION"
}

recheck_claim_owner() {
  local current
  current="$(psql_current --set="proposal_id=${PROPOSAL_ID}" \
    --set="lease_token=${LEASE_TOKEN}" <<'SQL'
WITH global_owner AS (
  SELECT max(fm.family_id::text)::uuid AS family_id,
         max(fm.user_id::text)::uuid AS user_id,
         max(owner_user.telegram_user_id) AS telegram_user_id
    FROM family_memberships fm
    JOIN users owner_user ON owner_user.id = fm.user_id
   WHERE fm.role = 'owner'
  HAVING count(*) = 1
)
SELECT EXISTS (
  SELECT 1
    FROM software_update_proposals proposal
    JOIN global_owner owner
      ON owner.family_id = proposal.family_id
     AND owner.user_id = proposal.expected_owner_user_id
     AND owner.telegram_user_id = proposal.expected_owner_telegram_user_id
   WHERE proposal.id = :'proposal_id'::uuid
     AND proposal.status = 'deploying'
     AND proposal.deployment_lease_token = :'lease_token'::uuid
     AND proposal.deployment_lease_expires_at > now()
);
SQL
)"
  [[ "$current" == "t" ]] ||
    fail "DEPLOY_OWNER_CHANGED" "Current global owner no longer matches the claimed proposal"
}

record_proposal_result() {
  local status="$1"
  local code="$2"
  local message="$3"
  local updated
  [[ -z "$PROPOSAL_ID" ]] && return 0
  updated="$(psql_current --set="proposal_id=${PROPOSAL_ID}" \
    --set="lease_token=${LEASE_TOKEN}" --set="result_status=${status}" \
    --set="result_code=${code}" --set="result_message=${message}" <<'SQL'
UPDATE software_update_proposals
   SET status = :'result_status',
       result = jsonb_build_object('code', :'result_code', 'message', :'result_message'),
       result_error_code = CASE WHEN :'result_status' = 'succeeded' THEN NULL ELSE :'result_code' END,
       result_error_message = CASE WHEN :'result_status' = 'succeeded' THEN NULL ELSE :'result_message' END,
       deployment_lease_token = NULL,
       deployment_lease_expires_at = NULL,
       completed_at = now(),
       updated_at = now()
 WHERE id = :'proposal_id'::uuid
   AND status = 'deploying'
   AND deployment_lease_token = :'lease_token'::uuid
   AND deployment_lease_expires_at > now()
RETURNING id::text;
SQL
)"
  if [[ "$updated" != "$PROPOSAL_ID" ]]; then
    fail "DEPLOY_PROPOSAL_RESULT_CONFLICT" "Proposal lease no longer belongs to this process"
    return 1
  fi
  TERMINAL_RECORDED=1
}

resolve_initial_owner_chat() {
  local chats
  chats="$(psql_current <<'SQL'
SELECT owner_user.telegram_user_id
  FROM family_memberships fm
  JOIN users owner_user ON owner_user.id = fm.user_id
 WHERE fm.role = 'owner'
 ORDER BY fm.created_at
 LIMIT 2;
SQL
)"
  [[ "$chats" =~ ^-?[0-9]+$ ]] && OWNER_CHAT_ID="$chats"
}
