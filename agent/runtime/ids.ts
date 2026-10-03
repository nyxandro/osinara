/**
 * Identifiers the runtime issues.
 *
 * Exports:
 * - `newTurnId`: `turn_<ULID>`, unique across sessions. Exactly-once barrier tables are unique on
 *   session plus turn, so a per-session counter (Eve's `turn_0`, `turn_1`) would collide with the
 *   turns of an imported session.
 * - `newSessionId`: `wrun_<ULID>`, the shape Eve gave sessions; the sandbox runner validates it.
 *
 * A ULID is 48 bits of millisecond time and 80 random bits in Crockford base32, so ids sort by
 * creation time.
 */
import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_CHARACTERS = 10;
const RANDOM_CHARACTERS = 16;

function ulid(now: number): string {
  let time = "";
  let remaining = now;
  for (let index = 0; index < TIME_CHARACTERS; index += 1) {
    time = CROCKFORD[remaining % 32] + time;
    remaining = Math.floor(remaining / 32);
  }
  const bytes = randomBytes(RANDOM_CHARACTERS);
  let random = "";
  for (const byte of bytes) random += CROCKFORD[byte % 32];
  return time + random;
}

export function newTurnId(now: number = Date.now()): string {
  return `turn_${ulid(now)}`;
}

export function newSessionId(now: number = Date.now()): string {
  return `wrun_${ulid(now)}`;
}
