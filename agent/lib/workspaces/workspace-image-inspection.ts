/**
 * Persistent workspace vision boundary.
 *
 * Exports:
 * - `createWorkspaceImageInspector`: validates and submits authorized image bytes.
 * - `inspectWorkspaceImage`: production Qwen vision inspector.
 */
import { generateText } from "ai";

import { VISION_MAX_FILE_BYTES } from "../../config.js";
import { scanAttachmentForMalware } from "../attachments/clamav-scanner.js";
import { visionModel } from "../model-registry.js";
import { AppError } from "../app-error.js";
import {
  type WorkspaceBinaryFile,
  workspaceBinaryRepository,
} from "./workspace-binary-repository.js";
import type {
  WorkspaceAuthorization,
  WorkspaceScope,
} from "./workspace-repository.js";

interface ImageAnalysisInput {
  abortSignal?: AbortSignal;
  bytes: Uint8Array;
  mediaType: string;
  question: string;
}

interface WorkspaceImageInspectorDependencies {
  analyze(input: ImageAnalysisInput): Promise<string>;
  readBinary(
    auth: WorkspaceAuthorization,
    scope: WorkspaceScope,
    path: string,
  ): Promise<WorkspaceBinaryFile>;
  scan(bytes: Uint8Array): Promise<void>;
}

export function createWorkspaceImageInspector(
  dependencies: WorkspaceImageInspectorDependencies,
) {
  return async (
    auth: WorkspaceAuthorization,
    input: {
      abortSignal?: AbortSignal;
      path: string;
      question: string;
      scope: WorkspaceScope;
    },
  ) => {
    const binary = await dependencies.readBinary(auth, input.scope, input.path);
    if (!binary.file.mediaType.startsWith("image/")) {
      throw new AppError(
        "AGENT_WORKSPACE_VISION_TYPE_UNSUPPORTED",
        "Vision-модель может повторно открыть из workspace только файл изображения",
      );
    }
    if (binary.bytes.byteLength > VISION_MAX_FILE_BYTES) {
      throw new AppError(
        "AGENT_WORKSPACE_VISION_FILE_TOO_LARGE",
        "Vision-модель принимает изображение размером не более 20 МБ",
      );
    }
    await dependencies.scan(binary.bytes);
    const analysis = await dependencies.analyze({
      ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
      bytes: binary.bytes,
      mediaType: binary.file.mediaType,
      question: input.question,
    });
    if (!analysis.trim()) {
      throw new AppError(
        "AGENT_WORKSPACE_VISION_RESPONSE_EMPTY",
        "Vision-модель не смогла описать изображение. Уточните вопрос и попробуйте снова",
      );
    }
    return { analysis, path: binary.file.path, scope: binary.file.scope };
  };
}

export const inspectWorkspaceImage = createWorkspaceImageInspector({
  async analyze(input) {
    const result = await generateText({
      ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
      messages: [{
        content: [
          { text: input.question, type: "text" },
          { data: input.bytes, mediaType: input.mediaType, type: "file" },
        ],
        role: "user",
      }],
      model: visionModel,
    });
    return result.text;
  },
  readBinary: workspaceBinaryRepository.readBinary,
  scan: scanAttachmentForMalware,
});
