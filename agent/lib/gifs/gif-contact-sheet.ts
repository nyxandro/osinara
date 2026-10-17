/**
 * Numbered contact sheet of GIF candidates for the vision model.
 *
 * Exports:
 * - `CONTACT_SHEET_CELL_SIZE`, `CONTACT_SHEET_GAP`: the sheet geometry.
 * - `gifPreviewFrame`: the middle frame of one preview, fitted into a square cell.
 * - `composeGifContactSheet`: up to six cells, three across, numbered from 1 in the given order.
 *
 * Key constructs:
 * - The middle frame stands for the animation: reaction GIFs often open with a fade-in or a neutral
 *   pose, while the point of the clip is usually reached by its middle.
 * - Numbers are drawn as seven-segment strokes in SVG, so the slim runtime image needs no fonts.
 * - A whole sheet becomes one image, so the vision model compares candidates in a single call.
 */
import { AppError } from "../app-error.js";
import { GIF_CONTACT_SHEET_SIZE } from "./gif-reply-config.js";

/**
 * The native image library loads with the first GIF reply, not with the agent: a broken native
 * build then fails one GIF instead of the whole process, and a runtime without GIF replies never
 * loads it.
 */
async function loadSharp() {
  const { default: sharp } = await import("sharp");
  // Every sheet is built once, so libvips' operation cache would only hold up to 50 MB of the agent
  // process's memory between rare GIF replies; this module is the process's only sharp user.
  sharp.cache(false);
  return sharp;
}

export const CONTACT_SHEET_CELL_SIZE = 256;
export const CONTACT_SHEET_GAP = 6;

const CONTACT_SHEET_COLUMNS = 3;
const CELL_BACKGROUND = { b: 24, g: 24, r: 24 };
const GAP_BACKGROUND = { b: 0, g: 0, r: 0 };
const SHEET_JPEG_QUALITY = 85;

const BADGE_SIZE = 64;
const DIGIT_LEFT = 20;
const DIGIT_TOP = 8;
const DIGIT_WIDTH = 24;
const DIGIT_HEIGHT = 48;
const STROKE = 6;

// Segments a (top), b (upper right), c (lower right), d (bottom), e (lower left), f (upper left),
// g (middle) of a seven-segment digit.
const DIGIT_SEGMENTS: Readonly<Record<number, string>> = {
  1: "bc",
  2: "abged",
  3: "abgcd",
  4: "fgbc",
  5: "afgcd",
  6: "afgecd",
  7: "abc",
  8: "abcdefg",
  9: "abcdfg",
};

const HALF = DIGIT_HEIGHT / 2;
const SEGMENT_RECTS: Readonly<Record<string, readonly [number, number, number, number]>> = {
  a: [DIGIT_LEFT, DIGIT_TOP, DIGIT_WIDTH, STROKE],
  b: [DIGIT_LEFT + DIGIT_WIDTH - STROKE, DIGIT_TOP, STROKE, HALF],
  c: [DIGIT_LEFT + DIGIT_WIDTH - STROKE, DIGIT_TOP + HALF, STROKE, HALF],
  d: [DIGIT_LEFT, DIGIT_TOP + DIGIT_HEIGHT - STROKE, DIGIT_WIDTH, STROKE],
  e: [DIGIT_LEFT, DIGIT_TOP + HALF, STROKE, HALF],
  f: [DIGIT_LEFT, DIGIT_TOP, STROKE, HALF],
  g: [DIGIT_LEFT, DIGIT_TOP + (DIGIT_HEIGHT - STROKE) / 2, DIGIT_WIDTH, STROKE],
};

function numberBadge(number: number): Buffer {
  const segments = DIGIT_SEGMENTS[number];
  if (segments === undefined) {
    throw new AppError("AGENT_GIF_CONTACT_SHEET_SIZE_INVALID", "На холсте можно пронумеровать не больше девяти гифок");
  }
  const strokes = [...segments].map((segment) => {
    const [x, y, width, height] = SEGMENT_RECTS[segment]!;
    return `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="#000"/>`;
  }).join("");
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${BADGE_SIZE}" height="${BADGE_SIZE}">` +
      `<rect x="1.5" y="1.5" width="${BADGE_SIZE - 3}" height="${BADGE_SIZE - 3}" fill="#FFD400" stroke="#000" stroke-width="3"/>` +
      `${strokes}</svg>`,
  );
}

export async function gifPreviewFrame(preview: Uint8Array): Promise<Buffer> {
  const sharp = await loadSharp();
  try {
    const { pages } = await sharp(preview, { animated: true }).metadata();
    return await sharp(preview, { page: Math.floor((pages ?? 1) / 2) })
      .flatten({ background: CELL_BACKGROUND })
      .resize(CONTACT_SHEET_CELL_SIZE, CONTACT_SHEET_CELL_SIZE, { background: CELL_BACKGROUND, fit: "contain" })
      .png()
      .toBuffer();
  } catch (error) {
    throw new AppError("AGENT_GIF_PREVIEW_INVALID", "Не удалось прочитать превью гифки", { cause: error });
  }
}

export async function composeGifContactSheet(frames: readonly Uint8Array[]): Promise<Uint8Array> {
  if (frames.length === 0 || frames.length > GIF_CONTACT_SHEET_SIZE) {
    throw new AppError(
      "AGENT_GIF_CONTACT_SHEET_SIZE_INVALID",
      `На холсте должно быть от 1 до ${GIF_CONTACT_SHEET_SIZE} гифок`,
    );
  }
  const sharp = await loadSharp();
  const cells = await Promise.all(frames.map(async (frame, index) => await sharp(frame)
    .composite([{ input: numberBadge(index + 1), left: 0, top: 0 }])
    .png()
    .toBuffer()));
  return await sharp(cells, {
    join: {
      across: Math.min(CONTACT_SHEET_COLUMNS, cells.length),
      background: GAP_BACKGROUND,
      shim: CONTACT_SHEET_GAP,
    },
  }).jpeg({ quality: SHEET_JPEG_QUALITY }).toBuffer();
}
