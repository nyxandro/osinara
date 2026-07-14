/**
 * Authorized Google Workspace command orchestration.
 *
 * Exports:
 * - `GoogleWorkspaceExecutionInput`: structured command plus authorized file bridges.
 * - `executeGoogleWorkspaceCommand`: bridges trusted personal/family files and a fresh user token.
 */
import { createHash } from "node:crypto";

import { AppError } from "../app-error.js";
import { workspaceBinaryRepository } from "../workspaces/workspace-binary-repository.js";
import type { WorkspaceAuthorization, WorkspaceScope } from "../workspaces/workspace-repository.js";
import { requireGoogleWorkspaceAccess } from "./google-workspace-access.js";
import {
  type GoogleWorkspaceCommand,
  isGoogleWorkspaceReadOnlyCommand,
  runGoogleWorkspaceCommand,
} from "./google-workspace-command.js";
import type { GoogleIntegrationAuthorization } from "./google-integration-repository.js";
import { googleOperationRepository } from "./google-operation-repository.js";

interface WorkspaceFileInput {
  contentType: string;
  path: string;
  scope: WorkspaceScope;
}

interface WorkspaceFileOutput {
  path: string;
  scope: WorkspaceScope;
}

export interface GoogleWorkspaceExecutionInput {
  command: GoogleWorkspaceCommand;
  output?: WorkspaceFileOutput;
  upload?: WorkspaceFileInput;
}

interface GoogleWorkspaceExecutionResult {
  account: string;
  data: unknown;
  outputFile?: unknown;
}

function workspaceAuthorization(auth: GoogleIntegrationAuthorization): WorkspaceAuthorization {
  return {
    familyId: auth.familyId,
    groupId: null,
    groupType: null,
    role: auth.role,
    telegramChatType: "private",
    userId: auth.userId,
  };
}

export async function executeGoogleWorkspaceCommand(
  auth: GoogleIntegrationAuthorization,
  input: GoogleWorkspaceExecutionInput,
  operationKey: string,
) {
  const fileAuth = workspaceAuthorization(auth);
  const upload = input.upload
    ? await workspaceBinaryRepository.readBinary(fileAuth, input.upload.scope, input.upload.path)
    : null;
  const access = await requireGoogleWorkspaceAccess(auth);
  const protectsMutation = input.upload !== undefined ||
    !isGoogleWorkspaceReadOnlyCommand(input.command);
  const operation = protectsMutation
    ? {
      operationKey,
      requestHash: createHash("sha256").update(JSON.stringify({
        command: input.command,
        output: input.output ?? null,
        upload: upload && input.upload
          ? {
            contentSha256: upload.file.contentSha256,
            contentType: input.upload.contentType,
            path: input.upload.path,
            scope: input.upload.scope,
          }
          : null,
      })).digest("hex"),
    }
    : null;
  if (operation) {
    const reservation = await googleOperationRepository.begin<GoogleWorkspaceExecutionResult>(
      auth,
      operation,
    );
    if (reservation.status === "completed") return reservation.result;
  }
  const result = await runGoogleWorkspaceCommand(input.command, access.accessToken, {
    ...(input.output ? { output: true } : {}),
    ...(upload && input.upload
      ? { upload: { bytes: upload.bytes, contentType: input.upload.contentType } }
      : {}),
  });

  // Downloads are copied into the authorized workspace only after gws exits successfully.
  let outputFile;
  if (input.output) {
    if (!result.outputBytes) {
      throw new AppError(
        "AGENT_GOOGLE_WORKSPACE_DOWNLOAD_MISSING",
        "Google Workspace не вернул ожидаемый файл. Проверьте параметры скачивания",
      );
    }
    outputFile = await workspaceBinaryRepository.writeBinary(fileAuth, {
      bytes: result.outputBytes,
      mediaType: "application/octet-stream",
      operationKey: `${operationKey}:google-workspace-output`,
      path: input.output.path,
      scope: input.output.scope,
    });
  }
  const response: GoogleWorkspaceExecutionResult = {
    account: access.accountDisplayName,
    data: result.data,
    ...(outputFile ? { outputFile } : {}),
  };
  if (operation) await googleOperationRepository.complete(auth, operation, response);
  return response;
}
