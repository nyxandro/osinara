/**
 * The check of a final answer's files before it reaches Telegram, phrased for the model.
 *
 * Exports:
 * - `answerFilesNotice`: undefined when every file of a final answer can go, else what the model is
 *   to fix.
 * - `reminderFilesError`: the same for a reminder being written, in Russian like its tool's other
 *   errors, limited to the folders of the chat the reminder will reach.
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
import type { WorkspaceScope } from "../workspaces/workspace-file-record.js";
import type { WorkspaceAuthorization } from "../workspaces/workspace-repository.js";
import { readAnswerMedia } from "./answer-file-references.js";
import {
  attachedTelegramAnswer,
  layOutPreparedAnswer,
  measureAnswerFiles,
  workspaceAddress,
  type AnswerFileOutcome,
  type AnswerFileResolver,
  type TelegramAnswerPresentationOptions,
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

type AnswerFileIssue =
  | { readonly address: string; readonly kind: "file"; readonly problem: AnswerFileProblem | "over_limit" }
  | { readonly address: string; readonly kind: "scope" }
  | { readonly address: string; readonly kind: "foreign"; readonly remote: boolean }
  | { readonly count: number; readonly kind: "unread" }
  | { readonly kind: "unfit" };

/**
 * What keeps the files of a text from going. `allowedScopes` names the folders of the chat the text
 * will reach when that chat is not the current one (a reminder); a file elsewhere is not measured.
 * `presentation` is how the text will be laid out, so the layout checked is the one delivered.
 */
async function answerFileIssues(input: {
  readonly allowedScopes?: readonly WorkspaceScope[];
  readonly auth: () => WorkspaceAuthorization | null;
  readonly presentation: TelegramAnswerPresentationOptions;
  readonly resolver: Pick<AnswerFileResolver, "measure">;
  readonly text: string;
}): Promise<AnswerFileIssue[]> {
  const reading = readAnswerMedia(input.text);
  const issues: AnswerFileIssue[] = [];
  const outOfScope = reading.files.filter((file) => input.allowedScopes !== undefined && !input.allowedScopes.includes(file.scope));
  for (const file of outOfScope) issues.push({ address: workspaceAddress(file), kind: "scope" });
  const files = reading.files.filter((file) => !outOfScope.includes(file));
  if (files.length > 0) {
    const outcomes = await measureAnswerFiles(files, input.auth(), input.resolver);
    for (const outcome of outcomes) {
      if ("problem" in outcome) issues.push({ address: workspaceAddress(outcome.reference), kind: "file", problem: outcome.problem });
    }
    const layout = layOutPreparedAnswer(input.text, outcomes.map(laidOutEstimate), CHECK_TURN_ID);
    if (attachedTelegramAnswer(layout, input.presentation) === null) issues.push({ kind: "unfit" });
  }
  for (const media of reading.foreign) issues.push({ address: media.address, kind: "foreign", remote: media.remote });
  if (reading.unread > 0) issues.push({ count: reading.unread, kind: "unread" });
  return issues;
}

function noticeLine(issue: AnswerFileIssue): string {
  switch (issue.kind) {
    case "file":
      return `- ${issue.address}: ${PROBLEM_TEXT[issue.problem]}.`;
    case "scope":
      return `- ${issue.address}: this folder is not available in the chat the text goes to.`;
    case "foreign":
      return issue.remote
        ? `- ${issue.address}: a web address is not sent. Download the file into a workspace folder with a tool first, then show it by its /workspace/... path.`
        : `- ${issue.address}: not a workspace file. Show a file by its full sandbox path: ![caption](/workspace/personal/...), /workspace/family/... or /workspace/group/....`;
    case "unread":
      return `- ${issue.count} workspace path${issue.count === 1 ? " was" : "s were"} not read as files: a plain link or a path with spaces shows nothing. Show a file as ![caption](/workspace/...) on its own line, and wrap a path with spaces in angle brackets: ![caption](</workspace/personal/My file.pdf>).`;
    case "unfit":
      return "- The answer cannot be a formatted message with its files (an over-wide table, too deep nesting, or captions that make a message too long), and only a formatted message carries files: simplify the formatting or shorten the captions.";
  }
}

export async function answerFilesNotice(input: {
  readonly auth: () => WorkspaceAuthorization | null;
  readonly resolver: Pick<AnswerFileResolver, "measure">;
  readonly text: string;
}): Promise<string | undefined> {
  const lines = new Set((await answerFileIssues({ ...input, presentation: { replyButtons: false } })).map(noticeLine));
  if (lines.size === 0) return undefined;
  return [
    "Your answer was not delivered: some files in it cannot be sent.",
    ...lines,
    "Write the whole answer again with these fixed or removed; you may call tools first. Do not mention this notice.",
  ].join("\n");
}

const REMINDER_PROBLEM_TEXT: Readonly<Record<AnswerFileProblem | "over_limit", string>> = {
  forbidden: "у этого чата нет доступа к этой папке",
  invalid_path: "это не путь к файлу рабочей папки",
  not_found: "файла нет в этой папке — проверь путь командой",
  over_limit: `в одно сообщение помещается не больше ${TELEGRAM_RICH_MESSAGE_MEDIA_MAX_COUNT} файлов и ${MEDIA_LIMIT_MB} МБ вместе`,
  too_large: `файл больше ${MEDIA_LIMIT_MB} МБ, Telegram его не примет — сожми или раздели его`,
};

function reminderLine(issue: AnswerFileIssue, allowedScopes: readonly WorkspaceScope[]): string {
  switch (issue.kind) {
    case "file":
      return `- ${issue.address}: ${REMINDER_PROBLEM_TEXT[issue.problem]}.`;
    case "scope":
      return `- ${issue.address}: напоминание придёт в чат, где эта папка недоступна; подходит ${allowedScopes.map((scope) => `/workspace/${scope}/...`).join(" или ")}.`;
    case "foreign":
      return issue.remote
        ? `- ${issue.address}: картинку из интернета сначала скачай в рабочую папку, потом укажи её путь /workspace/....`
        : `- ${issue.address}: это не файл рабочей папки — укажи полный путь: ![подпись](/workspace/<папка>/путь).`;
    case "unread":
      return `- путей к файлам, не распознанных как файл: ${issue.count}. Файл пишется отдельной строкой как ![подпись](/workspace/...), путь с пробелами — в угловых скобках.`;
    case "unfit":
      return "- с этими файлами напоминание не помещается в оформленное сообщение: упрости оформление или сократи подписи.";
  }
}

/**
 * What keeps a reminder's files from going, for the tool that writes it, or undefined when every
 * file can go. A reminder is sent later without the model, so its files are checked now.
 */
export async function reminderFilesError(input: {
  readonly allowedScopes: readonly WorkspaceScope[];
  readonly auth: () => WorkspaceAuthorization | null;
  readonly resolver: Pick<AnswerFileResolver, "measure">;
  readonly text: string;
}): Promise<string | undefined> {
  // A reminder is never collapsed; its buttons need a rich message, which its files already make.
  const issues = await answerFileIssues({ ...input, presentation: { keepExpanded: true, replyButtons: false } });
  const lines = new Set(issues.map((issue) => reminderLine(issue, input.allowedScopes)));
  if (lines.size === 0) return undefined;
  return ["Файлы в тексте напоминания не отправятся:", ...lines, "Исправь их или убери и повтори вызов."].join("\n");
}
