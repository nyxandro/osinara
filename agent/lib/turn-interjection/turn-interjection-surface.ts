/**
 * Interactive trusted tool surface that shows the running turn messages arriving meanwhile.
 *
 * Exports:
 * - `TURN_INTERJECTION_FRAMEWORK_TOOL_NAMES`: Eve built-ins re-emitted so their results can carry
 *   waiting messages too; long sandbox work is exactly where a correction arrives.
 * - `withTurnInterjectionSurface`: wraps a complete surface plus those built-ins.
 *
 * The built-ins are Eve's own public definitions, re-emitted unchanged under their framework names,
 * so descriptors, sandbox access, and read-before-write checks stay the framework's.
 */
import type { ToolDefinition } from "eve/tools";
import { bash, glob, grep, readFile, writeFile } from "eve/tools/defaults";

import { transcribeTelegramVoice } from "../groq-voice-transcription.js";
import { createTelegramVoiceAuthorizer } from "../telegram-voice-authorization.js";
import { telegramRepository } from "../telegram-repository.js";
import { createTurnInterjectionCollector } from "./turn-interjection-collector.js";
import { turnInterjectionRepository } from "./turn-interjection-repository.js";
import { withTurnInterjection } from "./turn-interjection-tool.js";

type AnyToolDefinition = ToolDefinition<any, any>;

export const TURN_INTERJECTION_FRAMEWORK_TOOL_NAMES = ["bash", "glob", "grep", "read_file", "write_file"] as const;

const FRAMEWORK_TOOLS: Readonly<Record<(typeof TURN_INTERJECTION_FRAMEWORK_TOOL_NAMES)[number], AnyToolDefinition>> = {
  bash,
  glob,
  grep,
  read_file: readFile,
  write_file: writeFile,
};

const turnInterjection = createTurnInterjectionCollector({
  authorizeVoice: createTelegramVoiceAuthorizer(telegramRepository),
  botUsername: process.env.TELEGRAM_BOT_USERNAME,
  repository: turnInterjectionRepository,
  transcribeVoice: transcribeTelegramVoice,
});

export function withTurnInterjectionSurface(
  surface: Readonly<Record<string, AnyToolDefinition>>,
): Record<string, AnyToolDefinition> {
  // An application tool of the same name keeps precedence over the framework built-in.
  const combined = { ...FRAMEWORK_TOOLS, ...surface };
  return Object.fromEntries(
    Object.entries(combined).map(([name, definition]) => [name, withTurnInterjection(definition, turnInterjection)]),
  );
}
