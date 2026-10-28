/**
 * A final answer with workspace files, prepared for the Telegram rich message that carries them.
 *
 * Exports:
 * - `measureAnswerFiles`: each reference measured with the chat's rights and admitted to the answer.
 * - `examineAnswerFiles`: the same, with the bytes of the admitted files loaded.
 * - `PreparedTelegramAnswer`: the answer text with a marker or a visible line on every file place.
 * - `prepareAnswerFiles`: reads, resolves and lays out the files of one answer.
 * - `presentTelegramAnswer`: the delivery chunks, each rich one with the files it shows.
 * - `withRefusedFiles`: a chunk's text with a visible line in place of each file Telegram refused.
 * - `withoutAnswerFiles`: the prepared answer as written, a visible line in place of each file, for
 *   an ordinary message that cannot carry them.
 * - `unreadAnswerFiles`: a text prepared with a visible line in place of each file, when its files
 *   could not be read at all.
 *
 * Key constructs:
 * - A file becomes a marker paragraph before formatting and a `tg://<kind>?id=` media block after
 *   it. The link filter never sees a media address the model wrote, and the media syntax appears
 *   only where this module put it. The marker is derived from the turn, so a replay prepares the
 *   same text and the delivery outbox recognizes it.
 * - A file that cannot go leaves a visible line with the reason and a stable code: the rest of the
 *   answer still arrives and the person sees what is missing. The model was already asked to fix it.
 * - Only a rich message carries media, and only as a block of its own. If the answer cannot be one
 *   (an over-wide table, too deep nesting, a file place that ended up inside literal paragraphs) or
 *   its files would push a message over Telegram's limit, it goes as written and every file place
 *   says why instead.
 * - A caption is model text placed after the link filter, so it passes that filter itself and stays
 *   within a caption's length.
 */
import { createHash } from "node:crypto";

import {
  TELEGRAM_RICH_MESSAGE_MEDIA_MAX_BYTES,
  TELEGRAM_RICH_MESSAGE_MEDIA_MAX_COUNT,
} from "../../config.js";
import type { WorkspaceAuthorization } from "../workspaces/workspace-repository.js";
import {
  formatTelegramFinalPresentation,
  type TelegramFinalPresentationChunk,
} from "../telegram-final-presentation.js";
import { fitsTelegramRichMessage } from "../telegram-rich-markdown.js";
import { neutralizeTelegramRichLinks } from "../telegram-rich-links.js";
import { richMediaBlockLines, type TelegramRichMediaUpload } from "../telegram-rich-messages.js";
import { layOutAnswerFiles, readAnswerMedia, type AnswerFileReference } from "./answer-file-references.js";
import {
  admitAnswerFiles,
  type AnswerFileMeasure,
  type AnswerFileProblem,
  type AnswerFileResolution,
  type MeasuredAnswerFile,
  type ResolvedAnswerFile,
} from "./answer-file-resolution.js";

export type AnswerFileOutcome<File extends MeasuredAnswerFile = ResolvedAnswerFile> =
  | { readonly file: File; readonly reference: AnswerFileReference }
  | { readonly problem: AnswerFileProblem | "over_limit"; readonly reference: AnswerFileReference };

export interface AnswerFileResolver {
  load(auth: WorkspaceAuthorization | null, reference: AnswerFileReference): Promise<AnswerFileResolution>;
  measure(auth: WorkspaceAuthorization | null, reference: AnswerFileReference): Promise<AnswerFileMeasure>;
}

interface AnswerFilePlace {
  readonly caption: string;
  readonly upload: TelegramRichMediaUpload;
}

export interface PreparedTelegramAnswer {
  /** The file places of the answer; null when it shows no file. */
  readonly files: { readonly marker: string; readonly places: ReadonlyMap<number, AnswerFilePlace> } | null;
  readonly markdown: string;
  /** Files that could not go, for the delivery log. */
  readonly problems: ReadonlyArray<{ readonly code: string; readonly path: string }>;
  /**
   * The answer as the model wrote it, when it shows files. A replay repeats that text exactly, while
   * the files on disk may have changed meanwhile, so it identifies the delivery.
   */
  readonly source: string | null;
}

export interface TelegramAnswerChunk extends TelegramFinalPresentationChunk {
  readonly media: readonly TelegramRichMediaUpload[];
}

export interface TelegramAnswerPresentationOptions {
  /** A notification stays expanded instead of collapsing under "Полный ответ". */
  readonly keepExpanded?: boolean;
  readonly replyButtons: boolean;
}

const MIB = 1024 * 1024;
// A caption is a line under a file, not a text of its own; Telegram's media captions stop at 1024.
const CAPTION_MAX_CHARACTERS = 1_024;
const MEDIA_LIMIT_MB = Math.floor(TELEGRAM_RICH_MESSAGE_MEDIA_MAX_BYTES / MIB);
const UNATTACHED_REASONS: Readonly<Record<AnswerFileProblem | "format_unfit" | "over_limit" | "read_failed" | "refused", readonly [string, string]>> = {
  forbidden: ["нет доступа к этой папке из текущего чата", "AGENT_ANSWER_FILE_FORBIDDEN"],
  format_unfit: ["ответ не поместился в оформленное сообщение", "AGENT_ANSWER_FILES_FORMAT_UNFIT"],
  invalid_path: ["путь к файлу указан неверно", "AGENT_ANSWER_FILE_PATH_INVALID"],
  not_found: ["файл не найден", "AGENT_ANSWER_FILE_NOT_FOUND"],
  over_limit: [
    `в одно сообщение помещается не больше ${TELEGRAM_RICH_MESSAGE_MEDIA_MAX_COUNT} файлов и ${MEDIA_LIMIT_MB} МБ вместе`,
    "AGENT_ANSWER_FILES_LIMIT_EXCEEDED",
  ],
  read_failed: ["файл не удалось прочитать", "AGENT_ANSWER_FILE_READ_FAILED"],
  refused: ["Telegram не принял файл", "AGENT_ANSWER_FILE_REFUSED"],
  too_large: [`файл больше ${MEDIA_LIMIT_MB} МБ`, "AGENT_ANSWER_FILE_TOO_LARGE"],
};

function fileKey(reference: { readonly path: string; readonly scope: string }): string {
  return `${reference.scope}/${reference.path}`;
}

export function workspaceAddress(reference: AnswerFileReference): string {
  return `/workspace/${reference.scope}/${reference.path}`;
}

/**
 * Each reference in the order written, measured without reading a byte; a file used again is
 * measured once, and the answer admits files only while its limits hold.
 */
export async function measureAnswerFiles(
  references: readonly AnswerFileReference[],
  auth: WorkspaceAuthorization | null,
  resolver: Pick<AnswerFileResolver, "measure">,
): Promise<Array<AnswerFileOutcome<MeasuredAnswerFile>>> {
  const measures = new Map<string, AnswerFileMeasure>();
  for (const reference of references) {
    const key = fileKey(reference);
    if (!measures.has(key)) measures.set(key, await resolver.measure(auth, reference));
  }
  const measured = references.map((reference) => measures.get(fileKey(reference))!);
  const admitted = admitAnswerFiles(measured.flatMap((measure) => measure.ok ? [measure.file] : []));
  let next = 0;
  return references.map((reference, index) => {
    const measure = measured[index]!;
    if (!measure.ok) return { problem: measure.problem, reference };
    const file = admitted[next++];
    return file ? { file, reference } : { problem: "over_limit", reference };
  });
}

/** The measured outcome with the bytes of every admitted file; each file is read once. */
export async function examineAnswerFiles(
  references: readonly AnswerFileReference[],
  auth: WorkspaceAuthorization | null,
  resolver: AnswerFileResolver,
): Promise<AnswerFileOutcome[]> {
  const loads = new Map<string, AnswerFileResolution>();
  const outcomes: AnswerFileOutcome[] = [];
  for (const outcome of await measureAnswerFiles(references, auth, resolver)) {
    if ("problem" in outcome) {
      outcomes.push(outcome);
      continue;
    }
    const key = fileKey(outcome.reference);
    if (!loads.has(key)) loads.set(key, await resolver.load(auth, outcome.reference));
    const loaded = loads.get(key)!;
    outcomes.push(loaded.ok ? { file: loaded.file, reference: outcome.reference } : { problem: loaded.problem, reference: outcome.reference });
  }
  return outcomes;
}

function unattachedLine(fileName: string, reason: keyof typeof UNATTACHED_REASONS): string {
  const [text, code] = UNATTACHED_REASONS[reason];
  return `⚠️ Не удалось приложить «${fileName}»: ${text} (${code})`;
}

function markerFor(turnId: string): string {
  return `OSINARAFILE${createHash("sha256").update(`answer-files:${turnId}`).digest("hex").slice(0, 12)}`;
}

export async function prepareAnswerFiles(input: {
  /** Asked only when the answer shows a file; null where the chat has no workspace. */
  readonly auth: () => WorkspaceAuthorization | null;
  readonly markdown: string;
  readonly resolver: AnswerFileResolver;
  readonly turnId: string;
}): Promise<PreparedTelegramAnswer> {
  const { files: references } = readAnswerMedia(input.markdown);
  if (references.length === 0) return { files: null, markdown: input.markdown, problems: [], source: null };
  const outcomes = await examineAnswerFiles(references, input.auth(), input.resolver);
  return layOutPreparedAnswer(input.markdown, outcomes, input.turnId);
}

/** The answer with a marker on every file that goes and a visible line on every one that cannot. */
export function layOutPreparedAnswer(
  markdown: string,
  outcomes: readonly AnswerFileOutcome[],
  turnId: string,
): PreparedTelegramAnswer {
  const references = outcomes.map((outcome) => outcome.reference);
  const marker = markerFor(turnId);
  const places = new Map<number, AnswerFilePlace>();
  const mediaIds = new Map<string, string>();
  const problems: Array<{ code: string; path: string }> = [];
  const laidOut = layOutAnswerFiles(markdown, references, (reference, index) => {
    const outcome = outcomes[index]!;
    if ("problem" in outcome) {
      problems.push({ code: UNATTACHED_REASONS[outcome.problem][1], path: workspaceAddress(reference) });
      return unattachedLine(reference.path.split("/").at(-1)!, outcome.problem);
    }
    const key = fileKey(outcome.file);
    const id = mediaIds.get(key) ?? `f${mediaIds.size}`;
    mediaIds.set(key, id);
    const { bytes, fileName, kind, mediaType, sha256 } = outcome.file;
    places.set(index, { caption: reference.caption, upload: { bytes, fileName, id, kind, mediaType, sha256 } });
    return `${marker}T${index}E`;
  });
  return { files: places.size === 0 ? null : { marker, places }, markdown: laidOut, problems, source: markdown };
}

function captionText(caption: string): string {
  const characters = Array.from(neutralizeTelegramRichLinks(caption));
  return characters.length <= CAPTION_MAX_CHARACTERS
    ? characters.join("")
    : `${characters.slice(0, CAPTION_MAX_CHARACTERS - 1).join("")}…`;
}

function mediaBlock(place: AnswerFilePlace): string {
  const caption = captionText(place.caption).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("<", "&lt;");
  const title = caption.length === 0 ? "" : ` "${caption}"`;
  return `![](tg://${place.upload.kind}?id=${place.upload.id}${title})`;
}

/**
 * The chunks with their files, or null when a file place landed in a plain chunk, anywhere but on
 * a line of its own, or in a message its files would push over Telegram's limit.
 */
function attachFiles(
  chunks: readonly TelegramFinalPresentationChunk[],
  files: NonNullable<PreparedTelegramAnswer["files"]>,
): TelegramAnswerChunk[] | null {
  const pattern = new RegExp(`${files.marker}T(\\d+)E`, "gu");
  const standalone = new RegExp(`^${files.marker}T\\d+E$`, "gmu");
  const attached: TelegramAnswerChunk[] = [];
  for (const chunk of chunks) {
    if (!chunk.text.includes(files.marker)) {
      attached.push({ ...chunk, media: [] });
      continue;
    }
    if (chunk.format !== "rich") return null;
    if ((chunk.text.match(pattern) ?? []).length !== (chunk.text.match(standalone) ?? []).length) return null;
    const media = new Map<string, TelegramRichMediaUpload>();
    const text = chunk.text.replace(pattern, (_marker, index: string) => {
      const place = files.places.get(Number(index))!;
      media.set(place.upload.id, place.upload);
      return mediaBlock(place);
    });
    if (!fitsTelegramRichMessage(text)) return null;
    attached.push({ ...chunk, media: [...media.values()], text });
  }
  return attached;
}

/** The chunks with every file in place, or null when the answer cannot be a rich message. */
export function attachedTelegramAnswer(
  answer: PreparedTelegramAnswer,
  options: TelegramAnswerPresentationOptions,
): TelegramAnswerChunk[] | null {
  const { files } = answer;
  if (files === null) {
    return formatTelegramFinalPresentation(answer.markdown, options).map((chunk) => ({ ...chunk, media: [] }));
  }
  const placeBlock = new RegExp(`^${files.marker}T\\d+E$`, "u");
  const chunks = formatTelegramFinalPresentation(answer.markdown, {
    ...options,
    isMediaBlock: (block) => placeBlock.test(block),
    requiresRich: (part) => part.includes(files.marker),
  });
  return attachFiles(chunks, files);
}

export function presentTelegramAnswer(
  answer: PreparedTelegramAnswer,
  options: TelegramAnswerPresentationOptions,
): TelegramAnswerChunk[] {
  const attached = attachedTelegramAnswer(answer, options);
  if (attached !== null) return attached;
  console.error(JSON.stringify({ code: "AGENT_ANSWER_FILES_FORMAT_UNFIT", files: answer.files!.places.size }));
  return formatTelegramFinalPresentation(withoutAnswerFiles(answer, "format_unfit"), options)
    .map((chunk) => ({ ...chunk, media: [] }));
}

/** The answer as written with a visible line in place of each file it was to show. */
export function withoutAnswerFiles(answer: PreparedTelegramAnswer, reason: "format_unfit" | "refused"): string {
  const { files } = answer;
  if (files === null) return answer.markdown;
  const pattern = new RegExp(`${files.marker}T(\\d+)E`, "gu");
  return answer.markdown.replace(pattern, (_marker, index: string) =>
    unattachedLine(files.places.get(Number(index))!.upload.fileName, reason));
}

/** The text with a visible line in place of each file it shows, none of them read. */
export function unreadAnswerFiles(markdown: string): PreparedTelegramAnswer {
  const { files: references } = readAnswerMedia(markdown);
  const problems = references.map((reference) => ({ code: UNATTACHED_REASONS.read_failed[1], path: workspaceAddress(reference) }));
  const laidOut = layOutAnswerFiles(markdown, references, (reference) => unattachedLine(reference.path.split("/").at(-1)!, "read_failed"));
  return { files: null, markdown: laidOut, problems, source: references.length === 0 ? null : markdown };
}

/**
 * The text of a chunk Telegram refused for good, with a visible line in place of each of its files:
 * the message was not delivered, so the same words may go once more without them.
 */
export function withRefusedFiles(text: string, media: readonly TelegramRichMediaUpload[]): string {
  const uploaded = new Map(media.map((upload) => [upload.id, upload]));
  let result = "";
  let cursor = 0;
  for (const block of richMediaBlockLines(text)) {
    const upload = uploaded.get(block.id);
    if (upload === undefined) continue;
    result += text.slice(cursor, block.range.start) + unattachedLine(upload.fileName, "refused");
    cursor = block.range.end;
  }
  return result + text.slice(cursor);
}
