/**
 * ElevenLabs-backed outbound Telegram voice message tool.
 *
 * Exports:
 * - `createSendVoiceMessageTool`: dependency-injected exact-once synthesis and delivery workflow.
 * - Default `send_voice_message`: production Eve tool using ElevenLabs, workspace, and Telegram.
 *
 * Key constructs:
 * - The verified workspace scope and call ID determine a stable non-overwriting output path.
 * - One durable reservation precedes the billable synthesis; no failure is retried implicitly.
 * - A stored voice note is delivered through the exact-once workspace file delivery ledger.
 * - Every failure is returned with the owner-defined recovery path: answer the request in text.
 */
import { createHash } from "node:crypto";

import { defineTool, type ToolContext, type ToolDefinition } from "eve/tools";
import { z } from "zod";

import { AppError, isAppError } from "../app-error.js";
import { telegramCaptionFits } from "../attachments/telegram-workspace-file-delivery.js";
import { sendWorkspaceFileToCurrentChat } from "../attachments/workspace-file-chat-delivery.js";
import { EVE_EMPTY_DELIVERY_MARKER } from "../eve-empty-delivery.js";
import {
  VOICE_MESSAGE_MEDIA_TYPE,
  VOICE_MESSAGE_TEXT_MAX_LENGTH,
  VoiceMessageProviderError,
  elevenLabsSpeechClient,
  type SynthesizedSpeech,
} from "../voice-messages/elevenlabs-speech-client.js";
import {
  voiceMessageOperationRepository,
  type VoiceMessageReservation,
} from "../voice-messages/voice-message-operation-repository.js";
import { voiceMessageFailure, voiceMessageInputError } from "../voice-messages/voice-message-errors.js";
import { requireWorkspaceAuthorization } from "../workspaces/workspace-context.js";
import { workspaceBinaryRepository } from "../workspaces/workspace-binary-repository.js";
import type { WorkspaceFileRecord } from "../workspaces/workspace-file-record.js";
import type { WorkspaceAuthorization, WorkspaceScope } from "../workspaces/workspace-repository.js";

type AnyToolDefinition = ToolDefinition<any, any>;

interface SendVoiceMessageDependencies {
  deliver(input: {
    caption?: string;
    path: string;
    scope: WorkspaceScope;
    text: string;
  }, ctx: ToolContext): Promise<Record<string, unknown>>;
  operations: {
    begin(input: {
      inputHash: string;
      operationKey: string;
      outputPath: string;
      workspaceId: string;
    }): Promise<VoiceMessageReservation>;
    complete(operationKey: string, file: WorkspaceFileRecord, characterCost: number | null): Promise<void>;
    markAmbiguous(operationKey: string, errorCode: string): Promise<void>;
    markFailed(operationKey: string, errorCode: string): Promise<void>;
  };
  speech: {
    assertConfigured(): void;
    synthesize(text: string): Promise<SynthesizedSpeech>;
  };
  workspaces: {
    findBinaryWrite(
      auth: WorkspaceAuthorization,
      scope: WorkspaceScope,
      operationKey: string,
    ): Promise<WorkspaceFileRecord | null>;
    workspaceId(auth: WorkspaceAuthorization, scope: WorkspaceScope): Promise<string>;
    writeBinary(auth: WorkspaceAuthorization, input: {
      bytes: Uint8Array;
      mediaType: string;
      operationKey: string;
      path: string;
      scope: WorkspaceScope;
    }): Promise<WorkspaceFileRecord>;
  };
}

const VOICE_CAPTION_MAX_LENGTH = 1_024;
const STATUS_UNKNOWN_CODE = "AGENT_VOICE_MESSAGE_STATUS_UNKNOWN";

const inputSchema = z.object({
  caption: z.string().trim().min(1).max(VOICE_CAPTION_MAX_LENGTH).optional()
    .describe("Необязательная подпись под голосовым: ссылки, адреса, код и другие данные, которые неудобно слушать"),
  text: z.string().trim().min(1).max(VOICE_MESSAGE_TEXT_MAX_LENGTH)
    .describe("Готовый текст, который будет произнесён голосом, без Markdown, ссылок и эмодзи"),
}).strict();

type SendVoiceMessageInput = z.infer<typeof inputSchema>;

function parseInput(input: unknown): SendVoiceMessageInput {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw voiceMessageInputError();
  // Checked before any credits are spent: Telegram would refuse the caption only after synthesis.
  if (parsed.data.caption !== undefined && !telegramCaptionFits(parsed.data.caption)) {
    throw voiceMessageInputError();
  }
  return parsed.data;
}

function outputPath(operationKey: string): string {
  const digest = createHash("sha256").update(operationKey, "utf8").digest("hex").slice(0, 24);
  return `generated-voice/voice-${digest}.ogg`;
}

function inputHash(input: SendVoiceMessageInput, scope: WorkspaceScope): string {
  return createHash("sha256").update(JSON.stringify({ scope, text: input.text }), "utf8").digest("hex");
}

function currentWorkspaceScope(auth: WorkspaceAuthorization): WorkspaceScope {
  if (auth.telegramChatType === "private" && auth.userId !== null) return "personal";
  if (auth.telegramChatType !== "private" && auth.groupId !== null) {
    if (auth.groupType === "family_private") return "family";
    if (auth.groupType === "external") return "group";
  }
  throw new AppError(
    "AGENT_WORKSPACE_CONTEXT_INVALID",
    "Не удалось определить область для сохранения голосового сообщения",
  );
}

function assertOutputMatches(file: WorkspaceFileRecord, scope: WorkspaceScope, expectedPath: string): void {
  if (file.path === expectedPath && file.scope === scope && file.mediaType === VOICE_MESSAGE_MEDIA_TYPE) return;
  throw new AppError(
    "AGENT_VOICE_MESSAGE_REPLAY_MISMATCH",
    "Сохранённое голосовое не совпадает с исходным запросом",
  );
}

function terminalReservationError(
  reservation: Extract<VoiceMessageReservation, { state: "ambiguous" | "failed" }>,
): AppError {
  return new AppError(
    reservation.errorCode,
    reservation.state === "ambiguous"
      ? "Не удалось подтвердить прошлую озвучку этого голосового"
      : "Прошлая попытка озвучить это голосовое завершилась ошибкой",
  );
}

function logLedgerFailure(code: string, operationKey: string, error: unknown): void {
  console.error(JSON.stringify({
    code,
    error: error instanceof Error ? error.message : String(error),
    operationKey,
  }));
}

async function settleProviderFailure(
  dependencies: SendVoiceMessageDependencies,
  operationKey: string,
  error: unknown,
): Promise<never> {
  const definitive = error instanceof VoiceMessageProviderError && error.outcome === "definitive";
  const errorCode = isAppError(error) ? error.code : STATUS_UNKNOWN_CODE;
  try {
    if (definitive) await dependencies.operations.markFailed(operationKey, errorCode);
    else await dependencies.operations.markAmbiguous(operationKey, errorCode);
  } catch (ledgerError) {
    logLedgerFailure("AGENT_VOICE_MESSAGE_LEDGER_SETTLEMENT_FAILED", operationKey, ledgerError);
  }
  throw error;
}

async function synthesizeAndStore(
  dependencies: SendVoiceMessageDependencies,
  auth: WorkspaceAuthorization,
  scope: WorkspaceScope,
  path: string,
  input: SendVoiceMessageInput,
  operationKey: string,
): Promise<{ characterCost: number | null; file: WorkspaceFileRecord }> {
  let speech: SynthesizedSpeech;
  try {
    speech = await dependencies.speech.synthesize(input.text);
  } catch (error) {
    return await settleProviderFailure(dependencies, operationKey, error);
  }
  let file: WorkspaceFileRecord;
  try {
    file = await dependencies.workspaces.writeBinary(auth, {
      bytes: speech.bytes,
      mediaType: speech.mediaType,
      operationKey,
      path,
      scope,
    });
  } catch (error) {
    logLedgerFailure("AGENT_VOICE_MESSAGE_PERSISTENCE_FAILED", operationKey, error);
    try {
      await dependencies.operations.markAmbiguous(operationKey, STATUS_UNKNOWN_CODE);
    } catch (ledgerError) {
      logLedgerFailure("AGENT_VOICE_MESSAGE_LEDGER_SETTLEMENT_FAILED", operationKey, ledgerError);
    }
    throw new AppError(STATUS_UNKNOWN_CODE, "Голосовое озвучено, но сохранить его для отправки не удалось");
  }
  try {
    await dependencies.operations.complete(operationKey, file, speech.characterCost);
  } catch (error) {
    // The workspace write is durable, so keeping `started` lets exact-call replay recover it.
    logLedgerFailure("AGENT_VOICE_MESSAGE_LEDGER_COMPLETION_FAILED", operationKey, error);
    throw new AppError(STATUS_UNKNOWN_CODE, "Голосовое озвучено и сохранено, но завершение операции не подтверждено");
  }
  return { characterCost: speech.characterCost, file };
}

async function recoverStartedOperation(
  dependencies: SendVoiceMessageDependencies,
  auth: WorkspaceAuthorization,
  scope: WorkspaceScope,
  operationKey: string,
  expectedPath: string,
): Promise<WorkspaceFileRecord> {
  const replay = await dependencies.workspaces.findBinaryWrite(auth, scope, operationKey);
  if (!replay) {
    throw new AppError(STATUS_UNKNOWN_CODE, "Не удалось подтвердить прошлую озвучку этого голосового");
  }
  assertOutputMatches(replay, scope, expectedPath);
  await dependencies.operations.complete(operationKey, replay, null);
  return replay;
}

async function sendVoiceMessage(
  dependencies: SendVoiceMessageDependencies,
  input: SendVoiceMessageInput,
  ctx: ToolContext,
): Promise<Record<string, unknown>> {
  const auth = requireWorkspaceAuthorization(ctx);
  const scope = currentWorkspaceScope(auth);
  dependencies.speech.assertConfigured();
  const workspaceId = await dependencies.workspaces.workspaceId(auth, scope);
  const path = outputPath(ctx.callId);
  const reservation = await dependencies.operations.begin({
    inputHash: inputHash(input, scope),
    operationKey: ctx.callId,
    outputPath: path,
    workspaceId,
  });

  let file: WorkspaceFileRecord;
  let characterCost: number | null = null;
  let generated = false;
  if (reservation.state === "completed") {
    file = reservation.file;
    assertOutputMatches(file, scope, path);
  } else if (reservation.state === "started") {
    file = await recoverStartedOperation(dependencies, auth, scope, ctx.callId, path);
  } else if (reservation.state === "failed" || reservation.state === "ambiguous") {
    throw terminalReservationError(reservation);
  } else {
    ({ characterCost, file } = await synthesizeAndStore(dependencies, auth, scope, path, input, ctx.callId));
    generated = true;
  }

  const delivery = await dependencies.deliver({
    ...(input.caption === undefined ? {} : { caption: input.caption }),
    path: file.path,
    scope,
    text: input.text,
  }, ctx);
  return {
    ...delivery,
    characterCost,
    generated,
    nextStep: `Голосовое уже доставлено и является твоим ответом: заверши ход ровно строкой ${EVE_EMPTY_DELIVERY_MARKER} без другого текста.`,
    path: file.path,
  };
}

export function createSendVoiceMessageTool(dependencies: SendVoiceMessageDependencies): AnyToolDefinition {
  return defineTool({
    description: [
      "Только по явной просьбе ответить голосом: озвучить text через ElevenLabs и отправить голосовым в текущий чат.",
      "text пиши как живую речь; ссылки и данные, которые неудобно слушать, передай в caption.",
      "После delivered=true следуй nextStep, при ошибке следуй correction и не повторяй вызов.",
    ].join(" "),
    inputSchema,
    async execute(rawInput, ctx) {
      try {
        return await sendVoiceMessage(dependencies, parseInput(rawInput), ctx);
      } catch (error) {
        throw voiceMessageFailure(error);
      }
    },
  }) as AnyToolDefinition;
}

export default createSendVoiceMessageTool({
  deliver: async (input, ctx) => await sendWorkspaceFileToCurrentChat({
    ...(input.caption === undefined ? {} : { caption: input.caption }),
    path: input.path,
    presentation: "voice",
    scope: input.scope,
    timelineText: input.caption === undefined
      ? `Голосовое сообщение: ${input.text}`
      : `Голосовое сообщение: ${input.text}\n\nПодпись: ${input.caption}`,
  }, ctx),
  operations: voiceMessageOperationRepository,
  speech: elevenLabsSpeechClient,
  workspaces: workspaceBinaryRepository,
});
