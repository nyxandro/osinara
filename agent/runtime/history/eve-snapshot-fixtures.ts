/**
 * Test doubles of Eve 0.40.0 turn snapshots, shared by the decoder and import tests.
 *
 * Exports:
 * - `storeLikeWorkflow`: encodes a step output with the layers @workflow/core and world-postgres
 *   apply before it reaches `workflow_steps.output_cbor`.
 * - `turnStepOutput`: the step output shape that carries a session snapshot.
 *
 * Test-only: imported by `*.test.ts` files, never by runtime code.
 */
import { gzipSync, zstdCompressSync } from "node:zlib";

import { encode } from "cbor-x";
import { stringify } from "devalue";

export type WorkflowCodec = "gzip" | "none" | "zstd";

export function storeLikeWorkflow(value: unknown, codec: WorkflowCodec): Uint8Array {
  const devalue = Buffer.concat([Buffer.from("devl"), Buffer.from(stringify(value), "utf8")]);
  const payload = codec === "zstd"
    ? Buffer.concat([Buffer.from("zstd"), zstdCompressSync(devalue)])
    : codec === "gzip" ? Buffer.concat([Buffer.from("gzip"), gzipSync(devalue)]) : devalue;
  return encode(new Uint8Array(payload));
}

export function turnStepOutput(
  sessionId: string,
  session: Record<string, unknown>,
  context: Record<string, unknown> = {},
) {
  return {
    action: "complete",
    serializedContext: { "eve.sessionId": sessionId, ...context },
    sessionState: { sessionId, version: 1, snapshot: { version: 1, session: { sessionId, ...session } } },
  };
}
