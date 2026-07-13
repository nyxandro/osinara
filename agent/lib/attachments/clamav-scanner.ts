/**
 * ClamAV streaming antivirus boundary.
 *
 * Exports:
 * - `createClamAvScanner`: submits in-memory bytes through clamd INSTREAM.
 * - `scanAttachmentForMalware`: production scanner using the private Docker service.
 */
import { createConnection } from "node:net";

import {
  CLAMAV_HOST,
  CLAMAV_PORT,
  CLAMAV_SCAN_TIMEOUT_MS,
} from "../../config.js";
import { AppError } from "../app-error.js";

const CLAMAV_CHUNK_BYTES = 64 * 1024;
const CLAMAV_INSTREAM_COMMAND = Buffer.from("zINSTREAM\0", "ascii");
const CLAMAV_TERMINATOR = Buffer.alloc(4);

function chunkFrame(bytes: Uint8Array): Buffer {
  const frame = Buffer.allocUnsafe(4 + bytes.byteLength);
  frame.writeUInt32BE(bytes.byteLength, 0);
  Buffer.from(bytes).copy(frame, 4);
  return frame;
}

function interpretScanResponse(response: string): void {
  if (response.endsWith(" OK")) return;
  if (response.endsWith(" FOUND")) {
    throw new AppError(
      "AGENT_ATTACHMENT_MALWARE_DETECTED",
      "Файл отклонён антивирусной проверкой и не был сохранён",
    );
  }
  throw new AppError(
    "AGENT_ATTACHMENT_SCAN_FAILED",
    "Антивирус не смог проверить файл. Попробуйте отправить его позже",
  );
}

export function createClamAvScanner(options: {
  host: string;
  port: number;
  timeoutMs: number;
}) {
  return async (bytes: Uint8Array): Promise<void> => {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = createConnection({ host: options.host, port: options.port });
      const chunks: Buffer[] = [];
      let settled = false;
      const fail = (error: AppError) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(error);
      };

      socket.setTimeout(options.timeoutMs, () => fail(new AppError(
        "AGENT_ATTACHMENT_SCAN_TIMEOUT",
        "Антивирус не успел проверить файл. Попробуйте отправить его позже",
      )));
      socket.on("error", (error) => {
        console.error(JSON.stringify({
          code: "AGENT_ATTACHMENT_SCANNER_UNAVAILABLE",
          errorName: error.name,
        }));
        fail(new AppError(
          "AGENT_ATTACHMENT_SCANNER_UNAVAILABLE",
          "Антивирус временно недоступен. Файл не сохранён; попробуйте позже",
        ));
      });
      socket.on("data", (chunk) => chunks.push(chunk));
      socket.on("end", () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks).toString("utf8").replace(/\0+$/u, "").trim());
      });
      socket.on("connect", () => {
        socket.write(CLAMAV_INSTREAM_COMMAND);
        for (let offset = 0; offset < bytes.byteLength; offset += CLAMAV_CHUNK_BYTES) {
          socket.write(chunkFrame(bytes.subarray(offset, offset + CLAMAV_CHUNK_BYTES)));
        }
        socket.write(CLAMAV_TERMINATOR);
      });
    });
    interpretScanResponse(response);
  };
}

export const scanAttachmentForMalware = createClamAvScanner({
  host: CLAMAV_HOST,
  port: CLAMAV_PORT,
  timeoutMs: CLAMAV_SCAN_TIMEOUT_MS,
});
