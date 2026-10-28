/**
 * The native image library of the agent process.
 *
 * Export:
 * - `loadSharp`: `sharp`, loaded on first use with its operation cache off.
 *
 * Key constructs:
 * - It loads with the first picture that needs it (a GIF contact sheet, the size of a photo in an
 *   answer), not with the agent: a broken native build then fails that operation instead of the
 *   whole process, and a turn without pictures never loads it.
 * - Every image is processed once, so libvips' operation cache would only hold up to 50 MB of the
 *   agent process's memory between rare uses.
 */
export async function loadSharp() {
  const { default: sharp } = await import("sharp");
  sharp.cache(false);
  return sharp;
}
