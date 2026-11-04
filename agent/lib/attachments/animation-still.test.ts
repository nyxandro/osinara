/**
 * Tests of the still a Telegram animation reaches vision through.
 *
 * Constructs covered:
 * - `extractAnimationStill`: the middle frame of an H.264 MP4 and of a GIF, cut by the image's own
 *   FFmpeg, as a JPEG; the only frame of a one-frame GIF.
 * - Refusals for a file that is not an animation and for a broken MP4.
 *
 * The MP4 fixture is red, green and blue for one second each, with one key frame and a silent
 * audio track, so its middle frame is green only when the cut decodes from the start and ignores sound.
 */
import { readFile } from "node:fs/promises";

import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { extractAnimationStill } from "./animation-still.js";

const RED_GREEN_BLUE_MP4 = new URL("./test-fixtures/three-seconds-red-green-blue.mp4", import.meta.url);

async function solidFrame(red: number, green: number, blue: number): Promise<Buffer> {
  return await sharp({ create: { background: { b: blue, g: green, r: red }, channels: 3, height: 48, width: 64 } })
    .png()
    .toBuffer();
}

async function centerColor(image: Uint8Array): Promise<{ blue: number; green: number; red: number }> {
  const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true });
  const offset = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
  return { blue: data[offset + 2]!, green: data[offset + 1]!, red: data[offset]! };
}

function expectGreen(color: { blue: number; green: number; red: number }): void {
  expect(color.green).toBeGreaterThan(200);
  expect(color.red).toBeLessThan(60);
  expect(color.blue).toBeLessThan(60);
}

describe("extractAnimationStill", () => {
  it("cuts the middle frame of an H.264 MP4 into a JPEG", async () => {
    const still = await extractAnimationStill(await readFile(RED_GREEN_BLUE_MP4));

    expect((await fileTypeFromBuffer(still))?.mime).toBe("image/jpeg");
    expectGreen(await centerColor(still));
  });

  it("takes the middle frame of a GIF", async () => {
    const frames = await Promise.all([solidFrame(255, 0, 0), solidFrame(0, 255, 0), solidFrame(0, 0, 255)]);
    const gif = await sharp(frames, { join: { animated: true } }).gif({ delay: [1_000, 1_000, 1_000] }).toBuffer();

    const still = await extractAnimationStill(gif);

    expect((await fileTypeFromBuffer(still))?.mime).toBe("image/jpeg");
    expectGreen(await centerColor(still));
  });

  // A one-frame GIF has no frame after its middle moment: the frame is chosen by number.
  it("takes the only frame of a one-frame GIF", async () => {
    const gif = await sharp(await solidFrame(0, 255, 0)).gif().toBuffer();

    expectGreen(await centerColor(await extractAnimationStill(gif)));
  });

  it("refuses a file that is not an animation", async () => {
    await expect(extractAnimationStill(await solidFrame(0, 255, 0)))
      .rejects.toMatchObject({ code: "AGENT_ANIMATION_FORMAT_UNSUPPORTED" });
  });

  // The fixture keeps its index at the end, as Telegram's MP4s may: a cut-off file has none.
  it("refuses an MP4 cut off before its index", async () => {
    const truncated = (await readFile(RED_GREEN_BLUE_MP4)).subarray(0, 1_500);

    await expect(extractAnimationStill(truncated))
      .rejects.toMatchObject({ code: "AGENT_ANIMATION_STILL_FAILED" });
  });
});
