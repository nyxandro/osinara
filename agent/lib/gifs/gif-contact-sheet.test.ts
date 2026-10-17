/**
 * GIF contact sheet tests.
 *
 * Constructs covered:
 * - The frame shown for an animation is its middle one; a still preview shows its only frame.
 * - Every frame is fitted into the same square cell.
 * - The sheet lays cells out three across in the order given and numbers them from 1.
 * - Unreadable preview bytes and an impossible frame count fail with their own codes.
 */
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  CONTACT_SHEET_CELL_SIZE,
  CONTACT_SHEET_GAP,
  composeGifContactSheet,
  gifPreviewFrame,
} from "./gif-contact-sheet.js";

type Rgb = readonly [number, number, number];

const RED: Rgb = [220, 30, 30];
const GREEN: Rgb = [30, 200, 60];
const BLUE: Rgb = [30, 60, 220];
const GRAY: Rgb = [120, 120, 120];
const WHITE: Rgb = [250, 250, 250];

async function solid(color: Rgb, width = 120, height = 80): Promise<Buffer> {
  return await sharp({
    create: { background: { b: color[2], g: color[1], r: color[0] }, channels: 3, height, width },
  }).png().toBuffer();
}

async function animatedWebp(colors: readonly Rgb[]): Promise<Buffer> {
  const frames = await Promise.all(colors.map((color) => solid(color)));
  return await sharp(frames, { join: { animated: true } }).webp({ lossless: true }).toBuffer();
}

async function pixel(image: Uint8Array, x: number, y: number): Promise<Rgb> {
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const offset = (y * info.width + x) * info.channels;
  return [data[offset]!, data[offset + 1]!, data[offset + 2]!];
}

function near(actual: Rgb, expected: Rgb): boolean {
  return actual.every((channel, index) => Math.abs(channel - expected[index]!) <= 24);
}

function cellOrigin(index: number): { x: number; y: number } {
  const column = index % 3;
  const row = Math.floor(index / 3);
  return {
    x: column * (CONTACT_SHEET_CELL_SIZE + CONTACT_SHEET_GAP),
    y: row * (CONTACT_SHEET_CELL_SIZE + CONTACT_SHEET_GAP),
  };
}

describe("GIF preview frame", () => {
  it("shows the middle frame of an animation", async () => {
    const frame = await gifPreviewFrame(await animatedWebp([RED, GREEN, BLUE, GREEN, RED]));
    const center = CONTACT_SHEET_CELL_SIZE / 2;

    expect(near(await pixel(frame, center, center), BLUE)).toBe(true);
  });

  it("shows the only frame of a still preview in a square cell", async () => {
    const frame = await gifPreviewFrame(await sharp(await solid(GREEN)).webp().toBuffer());
    const metadata = await sharp(frame).metadata();
    const center = CONTACT_SHEET_CELL_SIZE / 2;

    expect([metadata.width, metadata.height]).toEqual([CONTACT_SHEET_CELL_SIZE, CONTACT_SHEET_CELL_SIZE]);
    expect(near(await pixel(frame, center, center), GREEN)).toBe(true);
  });

  it("names unreadable preview bytes", async () => {
    await expect(gifPreviewFrame(new TextEncoder().encode("not an image")))
      .rejects.toMatchObject({ code: "AGENT_GIF_PREVIEW_INVALID" });
  });
});

describe("GIF contact sheet", () => {
  it("lays six cells out three across and two down in the given order", async () => {
    const colors = [RED, GREEN, BLUE, GRAY, RED, GREEN];
    const frames = await Promise.all(colors.map(async (color) => await gifPreviewFrame(await solid(color, 256, 256))));

    const sheet = await composeGifContactSheet(frames);
    const metadata = await sharp(sheet).metadata();

    expect(metadata.format).toBe("jpeg");
    expect(metadata.width).toBe(3 * CONTACT_SHEET_CELL_SIZE + 2 * CONTACT_SHEET_GAP);
    expect(metadata.height).toBe(2 * CONTACT_SHEET_CELL_SIZE + CONTACT_SHEET_GAP);
    for (const [index, color] of colors.entries()) {
      const { x, y } = cellOrigin(index);
      // The lower-right corner of every cell is clear of its number badge.
      expect(near(await pixel(sheet, x + CONTACT_SHEET_CELL_SIZE - 10, y + CONTACT_SHEET_CELL_SIZE - 10), color)).toBe(true);
    }
  });

  it("keeps a short result on one row", async () => {
    const frames = await Promise.all([RED, GREEN].map(async (color) => await gifPreviewFrame(await solid(color))));

    const metadata = await sharp(await composeGifContactSheet(frames)).metadata();

    expect(metadata.width).toBe(2 * CONTACT_SHEET_CELL_SIZE + CONTACT_SHEET_GAP);
    expect(metadata.height).toBe(CONTACT_SHEET_CELL_SIZE);
  });

  it("numbers the cells so that neighbouring numbers look different", async () => {
    const frames = await Promise.all([WHITE, WHITE].map(async (color) => await gifPreviewFrame(await solid(color, 256, 256))));

    const sheet = await composeGifContactSheet(frames);
    const signatures = await Promise.all([0, 1].map(async (index) => {
      const { x, y } = cellOrigin(index);
      const badge = await sharp(sheet)
        .extract({ height: 64, left: x, top: y, width: 64 })
        .greyscale()
        .raw()
        .toBuffer();
      return Array.from(badge, (value) => (value < 128 ? 1 : 0)).join("");
    }));

    // Each badge carries dark digit strokes, and the strokes of 1 and 2 differ.
    expect(signatures[0]).toContain("1");
    expect(signatures[1]).toContain("1");
    expect(signatures[0]).not.toBe(signatures[1]);
  });

  it.each([0, 7])("refuses %i frames", async (count) => {
    const frame = await gifPreviewFrame(await solid(RED));

    await expect(composeGifContactSheet(Array.from({ length: count }, () => frame)))
      .rejects.toMatchObject({ code: "AGENT_GIF_CONTACT_SHEET_SIZE_INVALID" });
  });
});
