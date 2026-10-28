/**
 * The check of a final answer's files before it reaches Telegram, phrased for the model.
 *
 * Export:
 * - `answerFilesNotice`: undefined when every file can go, else what the model is to fix.
 *
 * Key constructs:
 * - It runs the same reading, rights, limits and layout as the delivery, so what it lets pass is
 *   what the delivery sends. It only measures the files and never reads their bytes; workspace
 *   rights are asked only when the answer shows a file.
 * - The notice names each place with its reason and the exact form to use. It is shown to the model
 *   once, with its own answer; the model may call a tool first (to download a file, to check a path).
 */
import {
  TELEGRAM_RICH_MESSAGE_MEDIA_MAX_BYTES,
  TELEGRAM_RICH_MESSAGE_MEDIA_MAX_COUNT,
} from "../../config.js";
import type { WorkspaceAuthorization } from "../workspaces/workspace-repository.js";
import { readAnswerMedia } from "./answer-file-references.js";
import {
  attachedTelegramAnswer,
  layOutPreparedAnswer,
  measureAnswerFiles,
  workspaceAddress,
  type AnswerFileOutcome,
  type AnswerFileResolver,
} from "./answer-file-delivery.js";
import type { AnswerFileProblem, MeasuredAnswerFile, ResolvedAnswerFile } from "./answer-file-resolution.js";

const MEDIA_LIMIT_MB = Math.floor(TELEGRAM_RICH_MESSAGE_MEDIA_MAX_BYTES / (1024 * 1024));
const PROBLEM_TEXT: Readonly<Record<AnswerFileProblem | "over_limit", string>> = {
  forbidden: "this chat has no access to that workspace",
  invalid_path: "not a valid workspace path",
  not_found: "no such file in that workspace; check the path with a tool",
  over_limit: `one answer carries at most ${TELEGRAM_RICH_MESSAGE_MEDIA_MAX_COUNT} files and ${MEDIA_LIMIT_MB} MB together`,
  too_large: `larger than ${MEDIA_LIMIT_MB} MB, which Telegram does not take; compress or split it`,
};
// Turn-independent: the check only asks whether the layout fits, it never sends it.
const CHECK_TURN_ID = "answer-file-check";

/**
 * A measured file as the layout needs it. Nothing is sent from it: the longest media kind gives the
 * message its largest size, so an answer that fits here fits with the real kinds too.
 */
function laidOutEstimate(outcome: AnswerFileOutcome<MeasuredAnswerFile>): AnswerFileOutcome {
  if ("problem" in outcome) return outcome;
  const file: ResolvedAnswerFile = { ...outcome.file, bytes: Buffer.alloc(0), kind: "document", mediaType: "", sha256: "" };
  return { file, reference: outcome.reference };
}

export async function answerFilesNotice(input: {
  readonly auth: () => WorkspaceAuthorization | null;
  readonly resolver: Pick<AnswerFileResolver, "measure">;
  readonly text: string;
}): Promise<string | undefined> {
  const reading = readAnswerMedia(input.text);
  if (reading.files.length === 0 && reading.foreign.length === 0 && reading.unread === 0) return undefined;
  const lines = new Set<string>();
  if (reading.files.length > 0) {
    const outcomes = await measureAnswerFiles(reading.files, input.auth(), input.resolver);
    for (const outcome of outcomes) {
      if ("problem" in outcome) lines.add(`- ${workspaceAddress(outcome.reference)}: ${PROBLEM_TEXT[outcome.problem]}.`);
    }
    const layout = layOutPreparedAnswer(input.text, outcomes.map(laidOutEstimate), CHECK_TURN_ID);
    if (attachedTelegramAnswer(layout, { replyButtons: false }) === null) {
      lines.add("- The answer cannot be a formatted message with its files (an over-wide table, too deep nesting, or captions that make a message too long), and only a formatted message carries files: simplify the formatting or shorten the captions.");
    }
  }
  for (const media of reading.foreign) {
    lines.add(media.remote
      ? `- ${media.address}: a web address is not sent. Download the file into a workspace folder with a tool first, then show it by its /workspace/... path.`
      : `- ${media.address}: not a workspace file. Show a file by its full sandbox path: ![caption](/workspace/personal/...), /workspace/family/... or /workspace/group/....`);
  }
  if (reading.unread > 0) {
    lines.add(`- ${reading.unread} workspace path${reading.unread === 1 ? " was" : "s were"} not read as files: a plain link or a path with spaces shows nothing. Show a file as ![caption](/workspace/...) on its own line, and wrap a path with spaces in angle brackets: ![caption](</workspace/personal/My file.pdf>).`);
  }
  if (lines.size === 0) return undefined;
  return [
    "Your answer was not delivered: some files in it cannot be sent.",
    ...lines,
    "Write the whole answer again with these fixed or removed; you may call tools first. Do not mention this notice.",
  ].join("\n");
}
