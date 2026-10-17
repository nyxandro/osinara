/**
 * Download of one GIF preview for the contact sheet.
 *
 * Export:
 * - `downloadGifPreview`: exact bytes of a KLIPY preview, bounded in time and size.
 *
 * The backend fetches a URL that a third-party response named, so only KLIPY's media host is
 * allowed and redirects are refused: a response must never steer the backend to another host.
 */
import { AppError } from "../app-error.js";
import {
  GIF_PREVIEW_DOWNLOAD_TIMEOUT_MS,
  GIF_PREVIEW_MAX_BYTES,
  KLIPY_MEDIA_HOSTS,
} from "./gif-reply-config.js";

function downloadFailed(cause?: unknown): AppError {
  return new AppError(
    "AGENT_GIF_PREVIEW_DOWNLOAD_FAILED",
    "Не удалось скачать превью гифки",
    cause === undefined ? undefined : { cause },
  );
}

function tooLarge(): AppError {
  return new AppError("AGENT_GIF_PREVIEW_TOO_LARGE", "Превью гифки превышает допустимый размер");
}

// Read incrementally so an incorrect or absent Content-Length cannot bypass the hard cap.
async function readBoundedBody(response: Response): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > GIF_PREVIEW_MAX_BYTES) throw tooLarge();
  if (!response.body) throw downloadFailed();
  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let receivedBytes = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    receivedBytes += chunk.value.byteLength;
    if (receivedBytes > GIF_PREVIEW_MAX_BYTES) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function downloadGifPreview(
  url: string,
  abortSignal?: AbortSignal,
  fetchImplementation: typeof fetch = fetch,
): Promise<Uint8Array> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !KLIPY_MEDIA_HOSTS.has(parsed.hostname)) {
    throw new AppError("AGENT_GIF_PREVIEW_HOST_FORBIDDEN", "Превью гифки размещено вне сервиса гифок");
  }
  const timeout = AbortSignal.timeout(GIF_PREVIEW_DOWNLOAD_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImplementation(parsed, {
      redirect: "error",
      signal: abortSignal === undefined ? timeout : AbortSignal.any([abortSignal, timeout]),
    });
  } catch (error) {
    throw downloadFailed(error);
  }
  if (!response.ok) {
    // An unread body keeps its connection open until garbage collection.
    await response.body?.cancel();
    throw downloadFailed();
  }
  return await readBoundedBody(response);
}
