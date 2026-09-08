/**
 * Stable application configuration.
 *
 * Exports:
 * - Agent compaction, per-turn model safety, session lifecycle, attachment, update, and timeout constants.
 * - Internal service locations and sandbox runner execution limits.
 * - Telegram group journal and proactive delivery model-context limits.
 * - Cross-process advisory-lock namespaces for sensitive workspace state.
 * - Bounded credentialed Google Workspace command execution.
 * - `requireRuntimeEnvironment`: reads required environment-specific values.
 */
import { z } from "zod";

export const AGENT_COMPACTION_THRESHOLD = 0.75;
// The model may perform substantial tool work, but one turn must never consume unbounded calls.
export const AGENT_MAX_MODEL_STEPS_PER_TURN = 32;
export const GROQ_TRANSCRIPTION_TIMEOUT_MS = 60_000;
export const GOOGLE_WORKSPACE_PROFILE_LOCK_HASH_SEED = 2;
export const GOOGLE_WORKSPACE_COMMAND_TIMEOUT_MS = 60_000;
export const SANDBOX_RUNNER_BASE_URL = "http://sandbox-runner:8080";
export const SESSION_INACTIVITY_DAYS = 30;
export const SESSION_GROUP_ROTATION_LOCK_HASH_SEED = 3;
// The local Workflow world replays cumulative filesystem artifacts. Rotate with enough headroom
// below the observed Eve 240-second replay failure at 118 completed production turns.
export const SESSION_MAX_COMPLETED_TURNS = 50;
export const SESSION_RETENTION_LEASE_MS = 15 * 60 * 1_000;
export const SESSION_RETENTION_DAYS = 1;
export const SESSION_TASK_ABANDONED_DAYS = 7;
export const SESSION_TASK_MAX_ACTIVE_PER_GROUP_TOPIC = 25;
export const SESSION_TASK_SWEEP_BATCH_SIZE = 100;
export const PROACTIVE_DELIVERY_CONTEXT_MAX_AGE_DAYS = 30;
export const PROACTIVE_DELIVERY_CONTEXT_MAX_CHARACTERS = 12_000;
export const PROACTIVE_DELIVERY_CONTEXT_MAX_ITEMS = 10;
export const PROACTIVE_DELIVERY_HISTORY_DEFAULT_LIMIT = 10;
export const PROACTIVE_DELIVERY_HISTORY_MAX_LIMIT = 50;
export const SOFTWARE_UPDATE_GITHUB_RESPONSE_MAX_BYTES = 1024 * 1024;
export const SOFTWARE_UPDATE_HTTP_TIMEOUT_MS = 15_000;
export const SOFTWARE_UPDATE_MANIFEST_MAX_BYTES = 64 * 1024;
// Мягко удалённый факт остаётся восстановимым это окно, затем вычищается физически вместе со
// связанными чанками и заявлениями по каскадам базовой таблицы.
export const MEMORY_SOFT_DELETE_RETENTION_DAYS = 30;
export const MEMORY_SOFT_DELETE_PURGE_BATCH_SIZE = 200;
export const TELEGRAM_API_REQUEST_TIMEOUT_MS = 15_000;
// An unanswered approval parks the Eve turn indefinitely: Eve keeps `session.waiting` for as long
// as it takes. The confirmation window bounds that wait so one ignored prompt cannot freeze a chat.
export const TELEGRAM_HITL_APPROVAL_TIMEOUT_MS = 5 * 60 * 1_000;
// One `respond` waits up to Eve's 30-second command-hook handover, so the lease must outlast a whole
// batch; a lease that expires mid-flight would let the next minute answer the same request twice.
export const TELEGRAM_HITL_TIMEOUT_LEASE_MS = 15 * 60 * 1_000;
export const TELEGRAM_HITL_TIMEOUT_SWEEP_BATCH_SIZE = 5;
export const TELEGRAM_HITL_TIMEOUT_SWEEP_TIMEOUT_MS = 180 * 1_000;
// The timeout sweep needs a route-scoped `attachSession`, which exists only inside an HTTP handler,
// so the minute schedule calls the agent's own private route. The port is fixed by `npm start`.
export const AGENT_INTERNAL_SELF_BASE_URL = "http://127.0.0.1:3000";
export const TELEGRAM_GROUP_JOURNAL_CONTEXT_CHARACTERS = 12_000;
export const TELEGRAM_GROUP_JOURNAL_CONTEXT_MESSAGES = 100;
export const TELEGRAM_GROUP_JOURNAL_RETENTION_MESSAGES = 10_000;
export const TELEGRAM_ATTACHMENT_REFERENCE_LIST_DEFAULT_LIMIT = 50;
export const TELEGRAM_ATTACHMENT_REFERENCE_LIST_MAX_LIMIT = 50;
export const TELEGRAM_GROUP_TRUST_LOCK_HASH_SEED = 1;
export const TELEGRAM_INGRESS_LEASE_MS = 15 * 60 * 1_000;
export const TELEGRAM_INGRESS_ADMISSION_TIMEOUT_MS = 15 * 60 * 1_000;
// Last-resort loss-of-observation window, longer than a runner's 30-minute command limit.
// Actual model silence is bounded by the native AI SDK policy, not this transport guard.
export const TELEGRAM_INGRESS_OBSERVER_IDLE_MS = 35 * 60 * 1_000;
export const TELEGRAM_INGRESS_CANCELLATION_GRACE_MS = 30_000;
// Bound expensive turns on the single-process deployment without letting groups occupy button slots.
export const TELEGRAM_INGRESS_MESSAGE_CONCURRENCY = 2;
export const TELEGRAM_INGRESS_CALLBACK_CONCURRENCY = 2;
export const TELEGRAM_MAX_INBOUND_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const TELEGRAM_MAX_ATTACHMENTS_PER_MESSAGE = 1;
export const TELEGRAM_MAX_OUTBOUND_DOCUMENT_BYTES = 50 * 1024 * 1024;
export const TELEGRAM_VOICE_MAX_BYTES = 20 * 1024 * 1024;
export const WORKSPACE_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const WORKSPACE_DELETION_LEASE_MS = 15 * 60 * 1_000;
export const WORKSPACE_TOOL_MAX_TEXT_BYTES = 1024 * 1024;
export const VISION_MAX_FILE_BYTES = 10_000_000;

const runtimeEnvironmentSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    GROQ_API_KEY: z.preprocess(
      (value) => value === "" ? undefined : value,
      z.string().min(1).optional(),
    ),
    INVITATION_SIGNING_SECRET: z.string().min(32),
    MODEL_API_KEY: z.string().regex(/^\S+$/u),
    TELEGRAM_BOT_TOKEN: z.string().min(1),
    TELEGRAM_BOT_USERNAME: z.string().min(1),
    TELEGRAM_WEBHOOK_SECRET_TOKEN: z.string().min(1),
  });

export function requireRuntimeEnvironment() {
  const parsed = runtimeEnvironmentSchema.safeParse(process.env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(
      `AGENT_REQUIRED_CONFIG_MISSING: Отсутствуют обязательные настройки: ${fields}`,
    );
  }
  return parsed.data;
}
