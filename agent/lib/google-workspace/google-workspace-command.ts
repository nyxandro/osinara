/**
 * Isolated `gws` command boundary.
 *
 * Exports:
 * - `GoogleWorkspaceCommand`: structured Discovery API invocation accepted by the application.
 * - `isGoogleWorkspaceReadOnlyCommand`: conservative HITL classifier.
 * - `buildGoogleWorkspaceArguments`: validates and serializes argv without a shell.
 * - `runGoogleWorkspaceCommand`: executes pinned gws with an ephemeral token and file bridge.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import { WORKSPACE_MAX_FILE_BYTES } from "../../config.js";
import { AppError } from "../app-error.js";
import {
  GOOGLE_WORKSPACE_COMMAND_JSON_MAX_CHARACTERS,
  GOOGLE_WORKSPACE_COMMAND_MAX_OUTPUT_BYTES,
  GOOGLE_WORKSPACE_COMMAND_TIMEOUT_MILLISECONDS,
  GOOGLE_WORKSPACE_PAGE_LIMIT_MAX,
} from "./google-workspace-config.js";

const GOOGLE_WORKSPACE_SERVICES = [
  "calendar",
  "chat",
  "docs",
  "drive",
  "gmail",
  "sheets",
  "tasks",
] as const;
const COMMAND_SEGMENT_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/u;
const READ_ONLY_METHODS = new Set([
  "download",
  "export",
  "findDirectMessage",
  "findGroupChats",
  "get",
  "list",
  "query",
  "search",
]);
const GWS_BINARY_PATH = resolve("node_modules/@googleworkspace/cli/bin/gws");
const execFileAsync = promisify(execFile);

// JSON text avoids provider-specific wrappers produced for unconstrained object values.
const jsonObjectTextSchema = z.string().min(2).max(GOOGLE_WORKSPACE_COMMAND_JSON_MAX_CHARACTERS);
export const googleWorkspaceCommandSchema = z.object({
  body: jsonObjectTextSchema.optional(),
  method: z.string().regex(COMMAND_SEGMENT_PATTERN),
  pageAll: z.boolean().optional(),
  pageLimit: z.number().int().min(1).max(GOOGLE_WORKSPACE_PAGE_LIMIT_MAX).optional(),
  params: jsonObjectTextSchema.optional(),
  resourcePath: z.array(z.string().regex(COMMAND_SEGMENT_PATTERN)).min(1).max(6),
  service: z.enum(GOOGLE_WORKSPACE_SERVICES),
  uploadContentType: z.string().min(1).max(200).optional(),
}).strict();

export type GoogleWorkspaceCommand = z.infer<typeof googleWorkspaceCommandSchema>;

interface TrustedCommandPaths {
  outputPath?: string;
  uploadPath?: string;
}

interface ProcessInvocation {
  args: string[];
  cwd: string;
  env: Record<string, string>;
  maxBuffer: number;
  timeoutMs: number;
}

type ProcessRunner = (invocation: ProcessInvocation) => Promise<{
  stderr: string;
  stdout: string;
}>;

interface RunGoogleWorkspaceCommandOptions {
  output?: boolean;
  runProcess?: ProcessRunner;
  upload?: {
    bytes: Uint8Array;
    contentType: string;
  };
}

export interface GoogleWorkspaceCommandResult {
  data: unknown;
  outputBytes?: Buffer;
}

function invalidCommand(): never {
  throw new AppError(
    "AGENT_GOOGLE_WORKSPACE_COMMAND_INVALID",
    "Команда Google Workspace содержит недопустимый сервис, ресурс или метод",
  );
}

function parseCommand(command: GoogleWorkspaceCommand): GoogleWorkspaceCommand {
  const parsed = googleWorkspaceCommandSchema.safeParse(command);
  return parsed.success ? parsed.data : invalidCommand();
}

function parseJsonObject(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new AppError(
      "AGENT_GOOGLE_WORKSPACE_COMMAND_JSON_INVALID",
      "Параметры Google Workspace должны быть корректным JSON-объектом",
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AppError(
      "AGENT_GOOGLE_WORKSPACE_COMMAND_JSON_INVALID",
      "Параметры Google Workspace должны быть JSON-объектом, а не списком или значением",
    );
  }
  return parsed as Record<string, unknown>;
}

export function isGoogleWorkspaceReadOnlyCommand(command: GoogleWorkspaceCommand): boolean {
  const parsed = googleWorkspaceCommandSchema.safeParse(command);
  if (!parsed.success || parsed.data.body || parsed.data.uploadContentType) return false;
  return READ_ONLY_METHODS.has(parsed.data.method);
}

export function buildGoogleWorkspaceArguments(
  command: GoogleWorkspaceCommand,
  paths: TrustedCommandPaths,
): string[] {
  const parsed = parseCommand(command);
  if ((parsed.uploadContentType && !paths.uploadPath) || (!parsed.uploadContentType && paths.uploadPath)) {
    invalidCommand();
  }

  // Values are serialized as individual argv entries, so JSON content can never become shell syntax.
  const args = [parsed.service, ...parsed.resourcePath, parsed.method];
  if (parsed.params) args.push("--params", JSON.stringify(parseJsonObject(parsed.params)));
  if (parsed.body) args.push("--json", JSON.stringify(parseJsonObject(parsed.body)));
  if (paths.uploadPath) {
    args.push("--upload", paths.uploadPath, "--upload-content-type", parsed.uploadContentType!);
  }
  if (paths.outputPath) args.push("--output", paths.outputPath);
  if (parsed.pageAll) args.push("--page-all");
  if (parsed.pageLimit !== undefined) args.push("--page-limit", String(parsed.pageLimit));
  args.push("--format", "json");
  return args;
}

async function productionProcessRunner(invocation: ProcessInvocation) {
  const result = await execFileAsync(GWS_BINARY_PATH, invocation.args, {
    cwd: invocation.cwd,
    encoding: "utf8",
    env: invocation.env,
    maxBuffer: invocation.maxBuffer,
    timeout: invocation.timeoutMs,
  });
  return { stderr: result.stderr, stdout: result.stdout };
}

function parseStructuredOutput(stdout: string, pageAll: boolean): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    if (pageAll) {
      try {
        return trimmed.split("\n").filter(Boolean).map((line) => JSON.parse(line));
      } catch {
        // The original parse error carries the relevant malformed-output boundary failure.
      }
    }
    console.error(JSON.stringify({
      code: "AGENT_GOOGLE_WORKSPACE_RESPONSE_INVALID",
      errorName: error instanceof Error ? error.name : "UnknownError",
    }));
    throw new AppError(
      "AGENT_GOOGLE_WORKSPACE_RESPONSE_INVALID",
      "Google Workspace вернул некорректный ответ. Попробуйте повторить запрос",
    );
  }
}

export async function runGoogleWorkspaceCommand(
  command: GoogleWorkspaceCommand,
  accessToken: string,
  options: RunGoogleWorkspaceCommandOptions = {},
): Promise<GoogleWorkspaceCommandResult> {
  if (!accessToken) {
    throw new AppError(
      "AGENT_GOOGLE_AUTH_REQUIRED",
      "Не найден действующий доступ к Google Workspace. Подключите аккаунт заново",
    );
  }
  if (options.upload && options.upload.bytes.byteLength > WORKSPACE_MAX_FILE_BYTES) {
    throw new AppError(
      "AGENT_GOOGLE_WORKSPACE_UPLOAD_TOO_LARGE",
      "Файл превышает допустимый размер для Google Workspace",
    );
  }

  const directory = await mkdtemp(join(tmpdir(), "osinara-gws-"));
  const configDirectory = join(directory, "config");
  const uploadPath = options.upload ? join(directory, "upload.bin") : undefined;
  const outputPath = options.output ? join(directory, "download.bin") : undefined;
  try {
    await mkdir(configDirectory, { mode: 0o700 });
    if (options.upload && uploadPath) {
      await writeFile(uploadPath, options.upload.bytes, { mode: 0o600 });
    }
    const preparedCommand = options.upload
      ? { ...command, uploadContentType: options.upload.contentType }
      : command;
    const args = buildGoogleWorkspaceArguments(preparedCommand, {
      ...(outputPath ? { outputPath } : {}),
      ...(uploadPath ? { uploadPath } : {}),
    });

    // A minimal environment prevents gws from discovering host credentials, config, or project .env files.
    const result = await (options.runProcess ?? productionProcessRunner)({
      args,
      cwd: directory,
      env: {
        GOOGLE_WORKSPACE_CLI_CONFIG_DIR: configDirectory,
        GOOGLE_WORKSPACE_CLI_TOKEN: accessToken,
        HOME: directory,
        NO_COLOR: "1",
      },
      maxBuffer: GOOGLE_WORKSPACE_COMMAND_MAX_OUTPUT_BYTES,
      timeoutMs: GOOGLE_WORKSPACE_COMMAND_TIMEOUT_MILLISECONDS,
    }).then(undefined, (error: unknown) => {
      console.error(JSON.stringify({
        code: "AGENT_GOOGLE_WORKSPACE_COMMAND_FAILED",
        errorName: error instanceof Error ? error.name : "UnknownError",
        method: command.method,
        service: command.service,
      }));
      if (error instanceof Error) {
        error.message =
          "AGENT_GOOGLE_WORKSPACE_COMMAND_FAILED: Google Workspace не выполнил запрос. Проверьте параметры или подключите аккаунт заново";
      }
      throw error;
    });

    let outputBytes: Buffer | undefined;
    if (outputPath) {
      const output = await stat(outputPath);
      if (output.size > WORKSPACE_MAX_FILE_BYTES) {
        throw new AppError(
          "AGENT_GOOGLE_WORKSPACE_DOWNLOAD_TOO_LARGE",
          "Файл Google Workspace превышает допустимый размер workspace",
        );
      }
      outputBytes = await readFile(outputPath);
    }
    return {
      data: parseStructuredOutput(result.stdout, preparedCommand.pageAll === true),
      ...(outputBytes ? { outputBytes } : {}),
    };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
