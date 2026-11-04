/**
 * The still a Telegram animation (a GIF) reaches vision through.
 *
 * Export:
 * - `extractAnimationStill`: the middle frame of an animation's file as a JPEG.
 *
 * Key constructs:
 * - Telegram delivers an animation as an H.264 MP4 or as a GIF (Bot API `Animation`), told apart by
 *   the bytes. Both are decoded by the image's own FFmpeg build, which reads only these two formats
 *   from a descriptor, opens no path and writes only JPEG (Dockerfile, stage `media-tools`); it runs
 *   outside the agent's process and privileges (`media-tool-process.ts`).
 * - The middle frame stands for the animation, as in the GIF picker (`gifs/gif-contact-sheet.ts`):
 *   a reaction GIF often opens with a fade-in or a neutral pose and reaches its point by the middle.
 *   It is chosen by number, not by time, so a one-frame animation still yields its frame.
 * - A failure of the tool on this file becomes `AGENT_ANIMATION_STILL_FAILED`, which the caller may
 *   answer with "no picture". A missing or unstartable tool and a failing temporary file stay what
 *   they are: they are a broken server, not a bad GIF.
 */
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileTypeFromBuffer } from "file-type";

import { AppError, isAppError } from "../app-error.js";
import { MEDIA_TOOL_INPUT_FD, type MediaToolRun, runMediaTool } from "./media-tool-process.js";

// A GIF of a few seconds is cut in tens of milliseconds; the limit only stops a hung decoder.
const MEDIA_TOOL_TIMEOUT_MS = 15_000;
const PROBE_MAX_OUTPUT_BYTES = 1_024;
const STILL_MAX_BYTES = 10 * 1024 * 1024;
// 4K is beyond any Telegram animation; a decoder refuses larger frames before allocating them.
const DECODER_MAX_PIXELS = 3_840 * 2_160;
// FFmpeg's MJPEG quality scale runs from 2 (best) to 31.
const STILL_JPEG_QUALITY = 3;
// The demuxers of the image's FFmpeg build: MP4 and its QuickTime family, and GIF.
const DEMUXER_BY_MEDIA_TYPE: Readonly<Record<string, string>> = {
  "image/gif": "gif",
  "video/3gpp": "mov",
  "video/3gpp2": "mov",
  "video/mp4": "mov",
  "video/quicktime": "mov",
  "video/x-m4v": "mov",
};
const FILE_FAILURE_CODES = new Set(["AGENT_MEDIA_TOOL_FAILED", "AGENT_MEDIA_TOOL_OUTPUT_TOO_LARGE", "AGENT_MEDIA_TOOL_TIMEOUT"]);

const DECODER_LIMITS = ["-threads", "1", "-max_pixels", String(DECODER_MAX_PIXELS)];

function stillFailed(details: Readonly<Record<string, string | number>>, cause?: unknown): AppError {
  return new AppError("AGENT_ANIMATION_STILL_FAILED", "Не удалось получить кадр гифки", {
    ...(cause === undefined ? {} : { cause }),
    details,
  });
}

async function runOnFile(path: string, run: Omit<MediaToolRun, "inputFd">): Promise<Buffer> {
  // A descriptor per run: the tools read it from wherever the previous one left its offset.
  const handle = await open(path, "r");
  try {
    return await runMediaTool({ ...run, inputFd: handle.fd });
  } finally {
    await handle.close();
  }
}

async function countFrames(path: string, demuxer: string): Promise<number> {
  const output = await runOnFile(path, {
    args: [
      "-v", "error", ...DECODER_LIMITS, "-f", demuxer, "-fd", String(MEDIA_TOOL_INPUT_FD),
      "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", "fd:",
    ],
    binary: "ffprobe",
    maxOutputBytes: PROBE_MAX_OUTPUT_BYTES,
    timeoutMs: MEDIA_TOOL_TIMEOUT_MS,
  });
  const text = output.toString("utf8").trim();
  const frames = Number(text);
  if (!Number.isSafeInteger(frames) || frames < 1) throw stillFailed({ frameCount: text.slice(0, 40) });
  return frames;
}

async function cutMiddleFrame(path: string, demuxer: string): Promise<Buffer> {
  const middle = Math.floor((await countFrames(path, demuxer)) / 2);
  return await runOnFile(path, {
    args: [
      "-nostdin", "-hide_banner", "-loglevel", "error", ...DECODER_LIMITS,
      "-f", demuxer, "-fd", String(MEDIA_TOOL_INPUT_FD), "-i", "fd:",
      "-map", "0:v:0", "-an", "-sn", "-dn",
      // JPEG takes full-range colour; `scale` converts the decoder's video range.
      "-vf", `select=eq(n\\,${middle}),scale=out_range=full`, "-fps_mode", "passthrough", "-frames:v", "1",
      "-c:v", "mjpeg", "-q:v", String(STILL_JPEG_QUALITY), "-f", "image2pipe", "pipe:1",
    ],
    binary: "ffmpeg",
    maxOutputBytes: STILL_MAX_BYTES,
    timeoutMs: MEDIA_TOOL_TIMEOUT_MS,
  });
}

export async function extractAnimationStill(bytes: Uint8Array): Promise<Buffer> {
  const detected = await fileTypeFromBuffer(bytes);
  const demuxer = detected === undefined ? undefined : DEMUXER_BY_MEDIA_TYPE[detected.mime];
  if (demuxer === undefined) {
    throw new AppError("AGENT_ANIMATION_FORMAT_UNSUPPORTED", "Гифка пришла в формате, из которого не получить кадр", {
      details: { detectedMediaType: detected?.mime ?? "unknown" },
    });
  }
  const directory = await mkdtemp(join(tmpdir(), "osinara-animation-"));
  let still: Buffer;
  try {
    const path = join(directory, "animation");
    await writeFile(path, bytes, { mode: 0o600 });
    still = await cutMiddleFrame(path, demuxer);
  } catch (error) {
    if (isAppError(error) && FILE_FAILURE_CODES.has(error.code)) throw stillFailed({ causeCode: error.code }, error);
    throw error;
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
  if (still.byteLength === 0) throw stillFailed({ causeCode: "AGENT_ANIMATION_STILL_EMPTY" });
  return still;
}
