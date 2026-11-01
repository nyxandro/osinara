/**
 * Owner management of API keys that skills in sandboxes use without ever seeing them.
 *
 * Export:
 * - `manage_api_keys`: requests a key from the owner, lists keys with their usage, grants and
 *   revokes them, deletes them.
 *
 * Key constructs:
 * - A request never carries the key. The tool opens a wait, and the application itself asks the
 *   owner in the private chat, naming the only address the key will go to; the owner's next
 *   message is taken out before the queue (`api-key-intake.ts`).
 * - Granting beyond the owner's own chat waits for the owner's button; one parser validates the
 *   input for the approval policy and for execution, so a bad call is denied before the card.
 * - Every change republishes the file the sandbox egress proxy reads.
 * - The application sends a message, so a call interrupted by a crash is not repeated: the model
 *   learns the outcome is unknown instead of the owner getting a second request.
 */
import { z } from "zod";

import { defineTool } from "../../runtime/tool.js";
import {
  API_KEY_AUTH_SCHEMES,
  API_KEY_NAME_PATTERN,
  apiKeyEnvironmentNames,
  isApiKeyAuthHeader,
  normalizeUpstreamBaseUrl,
  type ApiKeyAuthScheme,
} from "../api-keys/api-key-contract.js";
import { API_KEY_ENCRYPTION_KEY_ENVIRONMENT_NAME, requireApiKeyEncryptionKey } from "../api-keys/api-key-crypto.js";
import { API_KEY_INTAKE_GUARD_HOURS, API_KEY_INTAKE_MINUTES } from "../api-keys/api-key-intake.js";
import { apiKeyPublisher } from "../api-keys/api-key-projection.js";
import { apiKeyRepository, type ApiKeySummary, type ApiKeyTarget } from "../api-keys/api-key-repository.js";
import { apiKeyTelegram } from "../api-keys/api-key-telegram.js";
import { AppError, isAppError } from "../app-error.js";
import { requirePrivateTelegramOwner } from "../family-context.js";
import { TELEGRAM_GROUP_ID_PATTERN } from "../telegram-group-registration.js";
import {
  requireAction,
  requiredEnum,
  requiredString,
  requireInputRecord,
  requireOnlyFields,
  toolInputError,
} from "../tool-input-validation.js";

const INPUT_ERROR_CODE = "AGENT_API_KEY_INPUT_INVALID";
const TOOL_ACTIONS = ["request", "list", "grant", "revoke", "delete"] as const;
const TARGETS = ["personal", "family", "group"] as const;
const TOP_LEVEL_FIELDS = [
  "action", "authHeader", "authScheme", "baseUrl", "name", "purpose", "target", "telegramChatId",
] as const;
const PURPOSE_MAX_LENGTH = 200;
// One line of plain text: the purpose must not be able to add a line of its own to the request.
const CONTROL_CHARACTER = /\p{Cc}/u;
const MINUTE_MILLISECONDS = 60_000;
const HOUR_MILLISECONDS = 60 * MINUTE_MILLISECONDS;

const manageApiKeysSchema = z.object({
  action: z.enum(TOOL_ACTIONS).describe("Required action."),
  authHeader: z.string().optional().describe("For request: the header that carries the key, e.g. authorization or x-api-key."),
  authScheme: z.enum(API_KEY_AUTH_SCHEMES).optional().describe("For request: bearer sends `Bearer <key>`, raw sends the bare key."),
  baseUrl: z.string().optional().describe("For request: the service's HTTPS API base, e.g. https://api.example.com/v1."),
  name: z.string().optional().describe("Key name, e.g. neuraldeep; required except for list."),
  purpose: z.string().optional().describe("For request: what the key is for, shown to the owner."),
  target: z.enum(TARGETS).optional().describe("For grant and revoke: personal, family or group."),
  telegramChatId: z.string().optional().describe("For target=group: the external group's chat id."),
}).strict();

type ApiKeysInput =
  | { readonly action: "delete"; readonly name: string }
  | { readonly action: "grant"; readonly name: string; readonly target: ApiKeyTarget }
  | { readonly action: "revoke"; readonly name: string; readonly target: ApiKeyTarget }
  | { readonly action: "list" }
  | {
    readonly action: "request";
    readonly authHeader: string;
    readonly authScheme: ApiKeyAuthScheme;
    readonly baseUrl: string;
    readonly name: string;
    readonly purpose: string;
  };

function requireName(input: Record<string, unknown>): string {
  const name = requiredString(input, "name", INPUT_ERROR_CODE, "neuraldeep", { maxLength: 32 });
  if (!API_KEY_NAME_PATTERN.test(name)) {
    toolInputError(INPUT_ERROR_CODE, "Поле name — 2–32 строчные латинские буквы, цифры или _, начиная с буквы. Пример: neuraldeep");
  }
  return name;
}

function requireTarget(input: Record<string, unknown>): ApiKeyTarget {
  const kind = requiredEnum(input, "target", TARGETS, INPUT_ERROR_CODE);
  if (kind !== "group") return { kind };
  const telegramChatId = requiredString(input, "telegramChatId", INPUT_ERROR_CODE, "-1001234567890", { maxLength: 32 });
  if (!TELEGRAM_GROUP_ID_PATTERN.test(telegramChatId)) {
    toolInputError(INPUT_ERROR_CODE, "Поле telegramChatId — id внешней группы из статуса групп. Пример: -1001234567890");
  }
  return { kind, telegramChatId };
}

function parseApiKeysInput(raw: unknown): ApiKeysInput {
  const input = requireInputRecord(raw, "manage_api_keys", INPUT_ERROR_CODE);
  requireOnlyFields(input, TOP_LEVEL_FIELDS, "manage_api_keys", INPUT_ERROR_CODE);
  const action = requireAction(input, "manage_api_keys", TOOL_ACTIONS, INPUT_ERROR_CODE);
  if (action === "list") return { action };
  const name = requireName(input);
  if (action === "delete") return { action, name };
  if (action === "grant") return { action, name, target: requireTarget(input) };
  if (action === "revoke") return { action, name, target: requireTarget(input) };

  const purpose = requiredString(input, "purpose", INPUT_ERROR_CODE, "генерация картинок", {
    maxLength: PURPOSE_MAX_LENGTH,
  }).trim();
  if (CONTROL_CHARACTER.test(purpose)) {
    toolInputError(INPUT_ERROR_CODE, "Поле purpose — одна строка без переносов. Пример: генерация картинок");
  }
  const baseUrl = normalizeUpstreamBaseUrl(requiredString(input, "baseUrl", INPUT_ERROR_CODE, "https://api.example.com/v1"));
  if (baseUrl === null) {
    toolInputError(INPUT_ERROR_CODE, "Поле baseUrl — HTTPS-адрес API сервиса по имени, без порта, параметров и логина. Пример: https://api.example.com/v1");
  }
  const authHeader = requiredString(input, "authHeader", INPUT_ERROR_CODE, "authorization", { maxLength: 64 }).toLowerCase();
  if (!isApiKeyAuthHeader(authHeader)) {
    toolInputError(INPUT_ERROR_CODE, "Поле authHeader — имя заголовка, в котором сервис ждёт ключ. Пример: authorization или x-api-key");
  }
  const authScheme = requiredEnum(input, "authScheme", API_KEY_AUTH_SCHEMES, INPUT_ERROR_CODE);
  return { action, authHeader, authScheme, baseUrl, name, purpose };
}

function requireStorage(): void {
  try {
    requireApiKeyEncryptionKey(process.env[API_KEY_ENCRYPTION_KEY_ENVIRONMENT_NAME]);
  } catch (error) {
    throw new AppError(
      "AGENT_API_KEY_STORAGE_UNCONFIGURED",
      "Хранилище ключей на сервере не настроено: нет ключа шифрования ключей API. Его должен задать администратор сервера",
      { cause: error },
    );
  }
}

// The address leads, in the application's words; the model's purpose comes after it, labelled.
function intakeMessage(input: { baseUrl: string; name: string; purpose: string }): string {
  return [
    `🔑 Жду ключ «${input.name}». Он будет уходить только на ${input.baseUrl}`,
    `Для чего: ${input.purpose}`,
    "Пришлите следующим сообщением только сам ключ, без других слов. Агент ключа не увидит: я перехвачу сообщение до него, зашифрую ключ и удалю сообщение из чата.",
    `Жду ${API_KEY_INTAKE_MINUTES} минут. Если передумали — напишите что-нибудь другое.`,
  ].join("\n\n");
}

function keyForModel(key: ApiKeySummary, now: Date) {
  const awaiting = key.awaitingValueUntil !== null && key.awaitingValueUntil > now ? key.awaitingValueUntil : null;
  return {
    authHeader: key.authHeader,
    authScheme: key.authScheme,
    ...(awaiting ? { awaitingValueUntil: awaiting.toISOString() } : {}),
    baseUrl: key.upstreamBaseUrl,
    grants: key.grants.map((grant) => ({
      grantedAt: grant.grantedAt.toISOString(),
      lastUsedAt: grant.lastUsedAt?.toISOString() ?? null,
      target: grant.target,
      uses: grant.uses,
      usesLast7Days: grant.usesLast7Days,
    })),
    name: key.name,
    purpose: key.purpose,
    sandboxVariables: apiKeyEnvironmentNames(key.name),
    // A stored key may also await a new value; one that never got a value and no longer waits has none.
    status: key.valueStoredAt ? "stored" : awaiting ? "awaiting_value" : "value_missing",
    ...(key.valueStoredAt ? { valueStoredAt: key.valueStoredAt.toISOString() } : {}),
  };
}

const TOOL_DESCRIPTION = [
  "API keys of HTTP services for skills and scripts in sandboxes; the model never sees a key. Load the `api-keys` skill before use.",
  "request (name, purpose, baseUrl, authHeader, authScheme) makes the application ask the owner for the key itself; never ask for it in chat.",
  "grant/revoke (name, target personal|family|group, telegramChatId for group); grant beyond personal asks the owner to confirm. list shows keys and usage; delete removes a key.",
].join(" ");

export default defineTool({
  approval: (ctx) => {
    try {
      const input = parseApiKeysInput(ctx.toolInput);
      requirePrivateTelegramOwner(ctx);
      return input.action === "grant" && input.target.kind !== "personal" ? "user-approval" : "not-applicable";
    } catch (error) {
      // An expected refusal reaches the model as a denied call it can explain or correct.
      if (isAppError(error)) return { reason: error.message, type: "denied" };
      throw error;
    }
  },
  description: TOOL_DESCRIPTION,
  inputSchema: manageApiKeysSchema,
  async execute(raw, ctx) {
    const input = parseApiKeysInput(raw);
    const owner = requirePrivateTelegramOwner(ctx);

    if (input.action === "list") {
      const now = new Date();
      return { keys: (await apiKeyRepository.list(owner.familyId)).map((key) => keyForModel(key, now)) };
    }
    if (input.action === "delete") {
      const deleted = await apiKeyRepository.delete({ familyId: owner.familyId, name: input.name });
      await apiKeyPublisher.publish();
      return { name: input.name, status: deleted ? "deleted" : "not_found" };
    }
    if (input.action === "grant") {
      const result = await apiKeyRepository.grant({
        familyId: owner.familyId, grantedBy: owner.userId, name: input.name, target: input.target,
      });
      await apiKeyPublisher.publish();
      return { name: input.name, status: result.created ? "granted" : "already_granted" };
    }
    if (input.action === "revoke") {
      const revoked = await apiKeyRepository.revoke({
        familyId: owner.familyId, name: input.name, revokedBy: owner.userId, target: input.target,
      });
      // Published even when nothing was left to revoke: a retry after a failed publication must
      // still close the grant in the proxy.
      await apiKeyPublisher.publish();
      return { name: input.name, status: revoked ? "revoked" : "not_found" };
    }

    requireStorage();
    const expiresAt = new Date(Date.now() + API_KEY_INTAKE_MINUTES * MINUTE_MILLISECONDS);
    const { keyId } = await apiKeyRepository.openIntake({
      authHeader: input.authHeader,
      authScheme: input.authScheme,
      expiresAt,
      familyId: owner.familyId,
      guardUntil: new Date(expiresAt.getTime() + API_KEY_INTAKE_GUARD_HOURS * HOUR_MILLISECONDS),
      name: input.name,
      ownerUserId: owner.userId,
      purpose: input.purpose,
      telegramChatId: owner.telegramChatId,
      upstreamBaseUrl: input.baseUrl,
    });
    // On any failure the wait closes and its guard stays: an owner who may not have seen the request
    // gets no ordinary message taken for the key, and a key sent anyway still never reaches the model.
    try {
      await apiKeyPublisher.publish();
    } catch (error) {
      await apiKeyRepository.cancelIntake({ keyId, telegramChatId: owner.telegramChatId });
      throw error;
    }
    try {
      await apiKeyTelegram.sendMessage(owner.telegramChatId, intakeMessage(input));
    } catch (error) {
      await apiKeyRepository.cancelIntake({ keyId, telegramChatId: owner.telegramChatId });
      throw new AppError(
        "AGENT_API_KEY_REQUEST_NOT_DELIVERED",
        "Не удалось отправить в чат запрос ключа, ожидание отменено. Попробуйте ещё раз",
        { cause: error },
      );
    }
    return {
      expiresAt: expiresAt.toISOString(),
      name: input.name,
      note: "The application has asked the owner for the key in a separate message. Do not ask for it or repeat that request.",
      sandboxVariables: apiKeyEnvironmentNames(input.name),
      status: "awaiting_value",
    };
  },
});
