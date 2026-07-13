/**
 * Stable application configuration.
 *
 * Exports:
 * - Named Groq language/transcription models and CLIProxy routes.
 * - Agent compaction, delegation, session lifecycle, attachment, and timeout constants.
 * - Internal service locations and sandbox runner execution limits.
 * - Telegram group journal retention and model-context limits.
 * - `requireRuntimeEnvironment`: reads required environment-specific values.
 */
import { z } from "zod";

export const AGENT_COMPACTION_THRESHOLD = 0.75;
export const AGENT_MAX_SUBAGENT_DEPTH = 0;
export const CLI_PROXY_MODEL_ID = "gpt-5.5";
export const CLI_PROXY_MODEL_ROUTE = "codex-subscription-gpt-5.5";
export const CLAMAV_HOST = "clamav";
export const CLAMAV_PORT = 3310;
export const CLAMAV_SCAN_TIMEOUT_MS = 30_000;
export const DOCUMENT_PARSER_BASE_URL = "http://document-parser:8080";
export const DOCUMENT_PARSER_TIMEOUT_MS = 30_000;
export const GROQ_GPT_OSS_MODEL_ID = "openai/gpt-oss-120b";
export const GROQ_GPT_OSS_MODEL_ROUTE = "groq-gpt-oss-120b";
export const GROQ_QWEN_MODEL_ID = "qwen/qwen3.6-27b";
export const GROQ_QWEN_MODEL_ROUTE = "groq-qwen3.6-27b";
export const GROQ_QWEN_TEMPERATURE = 0.6;
export const GROQ_TRANSCRIPTION_MODEL_ID = "whisper-large-v3-turbo";
export const GROQ_TRANSCRIPTION_TIMEOUT_MS = 60_000;
export const PRIMARY_MODEL_CONTEXT_WINDOW_TOKENS = 131_072;
export const PRIMARY_MODEL_ROUTE = GROQ_GPT_OSS_MODEL_ROUTE;
export const VISION_MODEL_ROUTE = GROQ_QWEN_MODEL_ROUTE;
export const SANDBOX_RUNNER_BASE_URL = "http://sandbox-runner:8080";
export const SESSION_INACTIVITY_DAYS = 30;
export const SESSION_MAX_COMPLETED_TURNS = 250;
export const SESSION_RETENTION_LEASE_MS = 15 * 60 * 1_000;
export const SESSION_RETENTION_DAYS = 90;
export const TELEGRAM_API_REQUEST_TIMEOUT_MS = 15_000;
export const TELEGRAM_GROUP_JOURNAL_CONTEXT_CHARACTERS = 12_000;
export const TELEGRAM_GROUP_JOURNAL_CONTEXT_MESSAGES = 50;
export const TELEGRAM_GROUP_JOURNAL_RETENTION_MESSAGES = 1_000;
export const TELEGRAM_INGRESS_LEASE_MS = 15 * 60 * 1_000;
export const TELEGRAM_MAX_INBOUND_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const TELEGRAM_MAX_ATTACHMENTS_PER_MESSAGE = 1;
export const TELEGRAM_MAX_OUTBOUND_DOCUMENT_BYTES = 50 * 1024 * 1024;
export const TELEGRAM_VOICE_MAX_BYTES = 20 * 1024 * 1024;
export const WORKSPACE_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const WORKSPACE_DELETION_LEASE_MS = 15 * 60 * 1_000;
export const WORKSPACE_PDF_VISION_PAGES_PER_CALL = 3;
export const WORKSPACE_TOOL_MAX_TEXT_BYTES = 1024 * 1024;
export const VISION_MAX_FILE_BYTES = 20 * 1024 * 1024;

const optionalEnvironmentValue = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);

const runtimeEnvironmentSchema = z
  .object({
    CLI_PROXY_API_KEY: optionalEnvironmentValue,
    CLI_PROXY_BASE_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.url().optional(),
    ),
    DATABASE_URL: z.string().min(1),
    GROQ_API_KEY: z.string().min(1),
    INVITATION_SIGNING_SECRET: z.string().min(32),
    TELEGRAM_BOT_TOKEN: z.string().min(1),
    TELEGRAM_BOT_USERNAME: z.string().min(1),
    TELEGRAM_WEBHOOK_SECRET_TOKEN: z.string().min(1),
  })
  .superRefine((environment, context) => {
    // An inactive retained route may be unconfigured, but partial credentials are invalid.
    if (Boolean(environment.CLI_PROXY_API_KEY) === Boolean(environment.CLI_PROXY_BASE_URL)) return;
    context.addIssue({
      code: "custom",
      message: "CLI_PROXY_API_KEY и CLI_PROXY_BASE_URL должны быть заданы вместе",
      path: ["CLI_PROXY_API_KEY"],
    });
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
