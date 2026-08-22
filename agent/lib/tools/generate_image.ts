/**
 * Subscription-backed raster image generation tool.
 *
 * Exports:
 * - `createGenerateImageTool`: dependency-injected exact-once generation and delivery workflow.
 * - Default `generate_image`: production Eve tool using CLIProxyAPI, workspace, and Telegram.
 *
 * Key constructs:
 * - The verified workspace scope and call ID determine a stable non-overwriting output path.
 * - One durable reservation precedes the billable provider call; no failure is retried implicitly.
 * - A completed image is delivered through the existing exact-once Telegram file sender.
 */
import { createHash } from "node:crypto";

import { defineTool, type ToolContext, type ToolDefinition } from "eve/tools";
import { z } from "zod";

import { AppError, isAppError } from "../app-error.js";
import { IMAGE_GENERATION_AVAILABLE } from "../image-generation/image-generation-availability.js";
import {
  imageGenerationClient,
  type ImageGenerationRequest,
} from "../image-generation/image-generation-client.js";
import {
  imageGenerationOperationRepository,
  type ImageGenerationReservation,
} from "../image-generation/image-generation-operation-repository.js";
import { requireWorkspaceAuthorization } from "../workspaces/workspace-context.js";
import { workspaceBinaryRepository } from "../workspaces/workspace-binary-repository.js";
import type { WorkspaceAuthorization, WorkspaceScope } from "../workspaces/workspace-repository.js";
import type { WorkspaceFileRecord } from "../workspaces/workspace-file-record.js";
import sendWorkspaceFile from "./send_workspace_file.js";

type AnyToolDefinition = ToolDefinition<any, any>;

interface GenerateImageDependencies {
  client: { generate(input: ImageGenerationRequest): Promise<{
    bytes: Buffer;
    mediaType: "image/webp";
    model: "gpt-image-2";
    revisedPrompt?: string;
  }> };
  deliver(input: {
    caption?: string;
    path: string;
    presentation: "photo";
    scope: WorkspaceScope;
  }, ctx: ToolContext): Promise<unknown>;
  operations: {
    begin(input: {
      inputHash: string;
      operationKey: string;
      outputPath: string;
      workspaceId: string;
    }): Promise<ImageGenerationReservation>;
    complete(operationKey: string, file: WorkspaceFileRecord): Promise<void>;
    markAmbiguous(operationKey: string, errorCode: string): Promise<void>;
    markFailed(operationKey: string, errorCode: string): Promise<void>;
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

const IMAGE_PROMPT_MAX_LENGTH = 8_000;
const IMAGE_CAPTION_MAX_LENGTH = 1_024;
const IMAGE_SIZES = ["1024x1024", "1536x1024", "1024x1536", "auto"] as const;
const IMAGE_QUALITIES = ["low", "medium", "high", "auto"] as const;
const IMAGE_BACKGROUNDS = ["transparent", "opaque", "auto"] as const;

const inputSchema = z.object({
  background: z.enum(IMAGE_BACKGROUNDS).describe("transparent, opaque или auto"),
  caption: z.string().min(1).max(IMAGE_CAPTION_MAX_LENGTH).optional()
    .describe("Необязательная подпись к отправленному изображению"),
  prompt: z.string().min(1).max(IMAGE_PROMPT_MAX_LENGTH)
    .describe("Полная визуальная спецификация изображения без служебных инструкций"),
  quality: z.enum(IMAGE_QUALITIES).describe("low, medium, high или auto"),
  scope: z.enum(["personal", "family", "group"])
    .describe("Workspace текущего доверенного контекста"),
  size: z.enum(IMAGE_SIZES).describe("1024x1024, 1536x1024, 1024x1536 или auto"),
}).strict();

type GenerateImageInput = z.infer<typeof inputSchema>;

function parseInput(input: unknown): GenerateImageInput {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError(
      "AGENT_IMAGE_GENERATION_INPUT_INVALID",
      "Не удалось проверить параметры изображения. Уточните описание и формат",
    );
  }
  return parsed.data;
}

function outputPath(operationKey: string): string {
  const digest = createHash("sha256").update(operationKey, "utf8").digest("hex").slice(0, 24);
  return `generated-images/image-${digest}.webp`;
}

function inputHash(input: GenerateImageInput): string {
  return createHash("sha256").update(JSON.stringify({
    background: input.background,
    prompt: input.prompt,
    quality: input.quality,
    scope: input.scope,
    size: input.size,
  }), "utf8").digest("hex");
}

function assertOutputMatches(
  file: WorkspaceFileRecord,
  scope: WorkspaceScope,
  expectedPath: string,
): void {
  if (file.path === expectedPath && file.scope === scope && file.mediaType === "image/webp") return;
  throw new AppError(
    "AGENT_IMAGE_GENERATION_REPLAY_MISMATCH",
    "Сохранённое изображение не совпадает с исходным запросом. Создайте новый запрос",
  );
}

function terminalReservationError(reservation: Extract<
  ImageGenerationReservation,
  { state: "ambiguous" | "failed" }
>): AppError {
  if (reservation.state === "ambiguous") {
    return new AppError(
      "AGENT_IMAGE_GENERATION_STATUS_UNKNOWN",
      "Не удалось подтвердить прошлую генерацию. Не повторяйте её без нового запроса",
    );
  }
  return new AppError(
    reservation.errorCode,
    "Прошлая генерация завершилась ошибкой. Создайте новый запрос",
  );
}

async function settleProviderFailure(
  dependencies: GenerateImageDependencies,
  operationKey: string,
  error: unknown,
): Promise<never> {
  const definitive = isAppError(error) && [
    "AGENT_IMAGE_GENERATION_CONFIG_INVALID",
    "AGENT_IMAGE_GENERATION_REJECTED",
  ].includes(error.code);
  const errorCode = isAppError(error) ? error.code : "AGENT_IMAGE_GENERATION_STATUS_UNKNOWN";
  try {
    if (definitive) await dependencies.operations.markFailed(operationKey, errorCode);
    else await dependencies.operations.markAmbiguous(operationKey, errorCode);
  } catch (ledgerError) {
    console.error(JSON.stringify({
      code: "AGENT_IMAGE_GENERATION_LEDGER_SETTLEMENT_FAILED",
      error: ledgerError instanceof Error ? ledgerError.message : String(ledgerError),
      operationKey,
      providerErrorCode: errorCode,
    }));
  }
  if (isAppError(error)) throw error;
  throw new AppError(
    "AGENT_IMAGE_GENERATION_STATUS_UNKNOWN",
    "Не удалось подтвердить результат генерации изображения. Не повторяйте запрос сразу",
  );
}

async function recoverStartedOperation(
  dependencies: GenerateImageDependencies,
  auth: WorkspaceAuthorization,
  input: GenerateImageInput,
  operationKey: string,
  expectedPath: string,
): Promise<WorkspaceFileRecord> {
  const replay = await dependencies.workspaces.findBinaryWrite(auth, input.scope, operationKey);
  if (!replay) {
    throw new AppError(
      "AGENT_IMAGE_GENERATION_STATUS_UNKNOWN",
      "Не удалось подтвердить прошлую генерацию. Не повторяйте её без нового запроса",
    );
  }
  assertOutputMatches(replay, input.scope, expectedPath);
  await dependencies.operations.complete(operationKey, replay);
  return replay;
}

export function createGenerateImageTool(dependencies: GenerateImageDependencies): AnyToolDefinition {
  return defineTool({
    description: [
      "Когда использовать: создать одно новое raster-изображение через GPT-Image-2 и сразу отправить его в текущий Telegram-чат.",
      "Не использовать: для SVG, диаграмм из кода, редактирования существующего файла или незапрошенной фоновой генерации.",
      "Вход: prompt описывает назначение, сцену, объект, композицию, стиль и запреты; scope берётся только из текущего контекста. Если размер или качество не заданы пользователем, передай auto.",
      "Результат: изображение сохраняется без перезаписи в generated-images и доставляется как photo; returned path можно использовать в следующих запросах.",
      "Ошибка: status unknown означает возможное списание лимита подписки; не повторяй вызов автоматически.",
    ].join(" "),
    inputSchema,
    async execute(rawInput, ctx) {
      // The mode surfaces never emit this descriptor without the subscription provider, so reaching
      // execution means a stale descriptor. Fail before the durable reservation records a call that
      // could never have been billed.
      if (!IMAGE_GENERATION_AVAILABLE) {
        throw new AppError(
          "AGENT_IMAGE_GENERATION_UNAVAILABLE",
          "Генерация изображений недоступна: текущая модель агента работает не через подписку OpenAI Codex",
        );
      }
      const input = parseInput(rawInput);
      const auth = requireWorkspaceAuthorization(ctx);
      const workspaceId = await dependencies.workspaces.workspaceId(auth, input.scope);
      const path = outputPath(ctx.callId);
      const reservation = await dependencies.operations.begin({
        inputHash: inputHash(input),
        operationKey: ctx.callId,
        outputPath: path,
        workspaceId,
      });

      let file: WorkspaceFileRecord;
      let generated = false;
      let revisedPrompt: string | undefined;
      if (reservation.state === "completed") {
        file = reservation.file;
        assertOutputMatches(file, input.scope, path);
      } else if (reservation.state === "started") {
        file = await recoverStartedOperation(dependencies, auth, input, ctx.callId, path);
      } else if (reservation.state === "failed" || reservation.state === "ambiguous") {
        throw terminalReservationError(reservation);
      } else {
        let generatedImage: Awaited<ReturnType<GenerateImageDependencies["client"]["generate"]>>;
        try {
          generatedImage = await dependencies.client.generate(input);
        } catch (error) {
          return await settleProviderFailure(dependencies, ctx.callId, error);
        }
        try {
          file = await dependencies.workspaces.writeBinary(auth, {
            bytes: generatedImage.bytes,
            mediaType: generatedImage.mediaType,
            operationKey: ctx.callId,
            path,
            scope: input.scope,
          });
        } catch (error) {
          console.error(JSON.stringify({
            code: "AGENT_IMAGE_GENERATION_PERSISTENCE_FAILED",
            error: error instanceof Error ? error.message : String(error),
            operationKey: ctx.callId,
          }));
          try {
            await dependencies.operations.markAmbiguous(
              ctx.callId,
              "AGENT_IMAGE_GENERATION_STATUS_UNKNOWN",
            );
          } catch (ledgerError) {
            console.error(JSON.stringify({
              code: "AGENT_IMAGE_GENERATION_LEDGER_SETTLEMENT_FAILED",
              error: ledgerError instanceof Error ? ledgerError.message : String(ledgerError),
              operationKey: ctx.callId,
            }));
          }
          throw new AppError(
            "AGENT_IMAGE_GENERATION_STATUS_UNKNOWN",
            "Изображение было создано, но его сохранение не подтверждено. Не повторяйте запрос сразу",
          );
        }
        try {
          await dependencies.operations.complete(ctx.callId, file);
        } catch (error) {
          // The workspace operation is durable, so retaining `started` lets exact-call replay recover it.
          console.error(JSON.stringify({
            code: "AGENT_IMAGE_GENERATION_LEDGER_COMPLETION_FAILED",
            error: error instanceof Error ? error.message : String(error),
            operationKey: ctx.callId,
          }));
          throw new AppError(
            "AGENT_IMAGE_GENERATION_STATUS_UNKNOWN",
            "Изображение создано и сохранено, но завершение операции не подтверждено. Не повторяйте запрос сразу",
          );
        }
        generated = true;
        revisedPrompt = generatedImage.revisedPrompt;
      }

      const delivery = await dependencies.deliver({
        ...(input.caption === undefined ? {} : { caption: input.caption }),
        path: file.path,
        presentation: "photo",
        scope: input.scope,
      }, ctx) as Record<string, unknown>;
      return {
        ...delivery,
        generated,
        model: "gpt-image-2",
        path: file.path,
        ...(revisedPrompt === undefined ? {} : { revisedPrompt }),
      };
    },
  }) as AnyToolDefinition;
}

export default createGenerateImageTool({
  client: imageGenerationClient,
  deliver: (input, ctx) => (sendWorkspaceFile as AnyToolDefinition).execute(input, ctx),
  operations: imageGenerationOperationRepository,
  workspaces: workspaceBinaryRepository,
});
