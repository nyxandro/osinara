/**
 * Controlled external-group web fetch.
 *
 * Exports:
 * - Resource-limit and proxy constants used by policy tests and runtime wiring.
 * - `CONTROLLED_WEB_FETCH_INPUT_SCHEMA`: Eve-compatible validated input contract.
 * - `createControlledWebFetch`: injectable secure HTTP executor for isolated tests.
 * - `controlledWebFetchTool`: Eve-compatible custom `web_fetch` definition.
 */
import { Buffer } from "node:buffer";

import {
  fetch as undiciFetch,
  ProxyAgent,
  type Dispatcher,
  type RequestInit,
  type Response,
} from "undici";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { AppError, isAppError } from "../app-error.js";

export const CONTROLLED_WEB_FETCH_PROXY_URL = "http://sandbox-egress-proxy:3128";
export const CONTROLLED_WEB_FETCH_MAX_REDIRECTS = 5;
export const CONTROLLED_WEB_FETCH_MAX_BODY_BYTES = 5 * 1024 * 1024;
export const CONTROLLED_WEB_FETCH_MAX_MODEL_BYTES = 50 * 1024;
export const CONTROLLED_WEB_FETCH_MAX_MODEL_LINES = 2_000;

const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 120;
const MILLISECONDS_PER_SECOND = 1_000;
const ALLOWED_PORTS = new Set(["", "80", "443"]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HTML_CONTENT_TYPE = "text/html";
const STRUCTURED_TEXT_CONTENT_TYPES = new Set(["application/json", "application/xml"]);
const STRUCTURED_TEXT_CONTENT_TYPE_SUFFIX = /^application\/[a-z0-9!#$&^_.+-]+\+(?:json|xml)$/u;
const MEDIA_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u;

export const CONTROLLED_WEB_FETCH_INPUT_SCHEMA = z.object({
  url: z.string(),
  format: z.enum(["html", "extracted_text"])
    .describe("html возвращает исходную HTML-разметку; extracted_text удаляет HTML-теги и возвращает обычный текст")
    .optional(),
  timeout: z.number().positive().max(MAX_TIMEOUT_SECONDS).optional(),
}).strict();

type ControlledWebFetchInput = z.infer<typeof CONTROLLED_WEB_FETCH_INPUT_SCHEMA>;

interface ControlledWebFetchResult {
  content: string;
  contentType: string;
  finalUrl: string;
  truncated: boolean;
}

type Fetch = (input: URL | string, init?: RequestInit) => Promise<Response>;

interface ControlledWebFetchDependencies {
  dispatcher: Dispatcher;
  fetch: Fetch;
}

interface ExecuteOptions {
  abortSignal?: AbortSignal;
}

const controlledWebFetchDispatcher = new ProxyAgent(CONTROLLED_WEB_FETCH_PROXY_URL);

function parseInput(input: unknown): ControlledWebFetchInput {
  const parsed = CONTROLLED_WEB_FETCH_INPUT_SCHEMA.safeParse(input);
  if (!parsed.success) {
    throw new AppError(
      "AGENT_WEB_FETCH_INPUT_INVALID",
      "Параметры загрузки страницы некорректны. Проверьте адрес, формат и таймаут",
    );
  }
  return parsed.data;
}

function validateUrl(value: string | URL, base?: URL): URL {
  let url: URL;
  try {
    url = value instanceof URL ? value : new URL(value, base);
  } catch {
    throw new AppError(
      "AGENT_WEB_FETCH_URL_INVALID",
      "Адрес страницы некорректен. Укажите полный адрес HTTP или HTTPS",
    );
  }

  // Credentials and uncommon ports must never cross the egress boundary.
  const validProtocol = url.protocol === "http:" || url.protocol === "https:";
  if (!validProtocol || url.username !== "" || url.password !== "" || !ALLOWED_PORTS.has(url.port)) {
    throw new AppError(
      "AGENT_WEB_FETCH_URL_FORBIDDEN",
      "Этот адрес нельзя загрузить. Используйте HTTP или HTTPS без учётных данных и нестандартного порта",
    );
  }
  return url;
}

function textContentType(response: Response): string {
  const value = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const supported = value !== undefined && MEDIA_TYPE_PATTERN.test(value) && (
    value.startsWith("text/") ||
    STRUCTURED_TEXT_CONTENT_TYPES.has(value) ||
    STRUCTURED_TEXT_CONTENT_TYPE_SUFFIX.test(value)
  );
  if (!supported) {
    void response.body?.cancel();
    throw new AppError(
      "AGENT_WEB_FETCH_CONTENT_TYPE_UNSUPPORTED",
      "Сайт вернул не текстовую страницу. Загрузка файлов через веб-доступ запрещена",
    );
  }
  return value;
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > CONTROLLED_WEB_FETCH_MAX_BODY_BYTES) {
    await response.body?.cancel();
    throw new AppError(
      "AGENT_WEB_FETCH_BODY_TOO_LARGE",
      "Страница слишком большая для безопасной загрузки. Выберите более компактный источник",
    );
  }

  // Read incrementally so a misleading or absent Content-Length cannot force unbounded buffering.
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > CONTROLLED_WEB_FETCH_MAX_BODY_BYTES) {
      await reader.cancel();
      throw new AppError(
        "AGENT_WEB_FETCH_BODY_TOO_LARGE",
        "Страница слишком большая для безопасной загрузки. Выберите более компактный источник",
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, totalBytes);
}

function decodeHtmlEntities(value: string): string {
  const namedEntities: Readonly<Record<string, string>> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(/&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/giu, (entity, decimal, hex, named) => {
    if (decimal) return String.fromCodePoint(Number(decimal));
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    return namedEntities[String(named).toLowerCase()] ?? entity;
  });
}

function htmlToText(html: string): string {
  // Remove non-content blocks before tags; no DOM dependency is needed for bounded model-safe text.
  return decodeHtmlEntities(
    html
      .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, " ")
      .replace(/<!--([\s\S]*?)-->/gu, " ")
      .replace(/<\s*br\s*\/?>/giu, "\n")
      .replace(/<\/\s*(?:p|div|article|section|li|h[1-6])\s*>/giu, "\n")
      .replace(/<[^>]*>/gu, " "),
  )
    .replace(/[\t ]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;

  // TextDecoder drops an incomplete trailing code point rather than emitting malformed UTF-8.
  return new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.subarray(0, maxBytes))
    .replace(/\uFFFD$/u, "");
}

function boundModelContent(value: string): { content: string; truncated: boolean } {
  const safeText = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "");
  const lines = safeText.split("\n");
  const lineBounded = lines.slice(0, CONTROLLED_WEB_FETCH_MAX_MODEL_LINES).join("\n");
  const content = truncateUtf8(lineBounded, CONTROLLED_WEB_FETCH_MAX_MODEL_BYTES);
  return {
    content,
    truncated: lines.length > CONTROLLED_WEB_FETCH_MAX_MODEL_LINES || content !== lineBounded,
  };
}

function requestSignal(timeoutSeconds: number, abortSignal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutSeconds * MILLISECONDS_PER_SECOND);
  return abortSignal ? AbortSignal.any([abortSignal, timeoutSignal]) : timeoutSignal;
}

export function createControlledWebFetch(dependencies: ControlledWebFetchDependencies) {
  return async (
    rawInput: ControlledWebFetchInput,
    options: ExecuteOptions = {},
  ): Promise<ControlledWebFetchResult> => {
    const input = parseInput(rawInput);
    const signal = requestSignal(input.timeout ?? DEFAULT_TIMEOUT_SECONDS, options.abortSignal);
    let currentUrl = validateUrl(input.url);

    try {
      for (let redirectCount = 0; redirectCount <= CONTROLLED_WEB_FETCH_MAX_REDIRECTS; redirectCount += 1) {
        // Every hop explicitly carries the same proxy dispatcher and total-deadline signal.
        const response = await dependencies.fetch(currentUrl, {
          dispatcher: dependencies.dispatcher,
          redirect: "manual",
          signal,
        });
        if (REDIRECT_STATUSES.has(response.status)) {
          await response.body?.cancel();
          if (redirectCount === CONTROLLED_WEB_FETCH_MAX_REDIRECTS) {
            throw new AppError(
              "AGENT_WEB_FETCH_REDIRECT_LIMIT",
              "Страница перенаправляет слишком много раз. Укажите конечный адрес",
            );
          }
          const location = response.headers.get("location");
          if (!location) {
            throw new AppError(
              "AGENT_WEB_FETCH_REDIRECT_INVALID",
              "Страница вернула некорректное перенаправление. Укажите другой адрес",
            );
          }
          currentUrl = validateUrl(location, currentUrl);
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          // The status tells a blocked site from an invented address or an outage; the path and
          // query may carry tokens, so only the origin reaches the log. A site's answer is not an
          // application failure, so the tool boundary records it without Eve's stack.
          throw new AppError(
            "AGENT_WEB_FETCH_RESPONSE_FAILED",
            `Сайт не отдал доступную страницу: HTTP ${response.status}. Проверьте адрес или попробуйте позже`,
            { details: { origin: currentUrl.origin, status: response.status }, isExpectedRefusal: true },
          );
        }

        // Reject files before buffering; web access is intentionally limited to model-readable text.
        const responseContentType = textContentType(response);
        const body = await readBoundedBody(response);
        const decoded = new TextDecoder("utf-8", { fatal: false }).decode(body);
        const requestedFormat = input.format ?? "extracted_text";
        const formatted = responseContentType === HTML_CONTENT_TYPE && requestedFormat !== "html"
          ? htmlToText(decoded)
          : decoded;
        const bounded = boundModelContent(formatted);
        return {
          ...bounded,
          contentType: responseContentType,
          finalUrl: currentUrl.toString(),
        };
      }
    } catch (error) {
      if (isAppError(error)) throw error;
      if (signal.aborted) {
        const interruptedByCaller = options.abortSignal?.aborted === true;
        throw new AppError(
          interruptedByCaller ? "AGENT_WEB_FETCH_CANCELLED" : "AGENT_WEB_FETCH_TIMEOUT",
          interruptedByCaller
            ? "Загрузка страницы отменена"
            : "Страница не загрузилась за отведённое время. Попробуйте другой источник",
        );
      }
      console.error("Controlled web fetch failed", {
        code: "AGENT_WEB_FETCH_REQUEST_FAILED",
        error,
        url: currentUrl.origin,
      });
      throw new AppError(
        "AGENT_WEB_FETCH_REQUEST_FAILED",
        "Не удалось загрузить страницу через защищённый шлюз. Попробуйте позже",
      );
    }

    throw new AppError(
      "AGENT_WEB_FETCH_REDIRECT_LIMIT",
      "Страница перенаправляет слишком много раз. Укажите конечный адрес",
    );
  };
}

export const executeControlledWebFetch = createControlledWebFetch({
  dispatcher: controlledWebFetchDispatcher,
  fetch: undiciFetch,
});

export const controlledWebFetchTool = defineTool({
  description: [
    "Загрузить HTTP(S)-страницу через защищённый сетевой шлюз.",
    "Формат extracted_text удаляет HTML-теги и возвращает обычный текст; формат html возвращает исходную разметку.",
    "По умолчанию используется extracted_text. Таймаут не более 120 секунд.",
    "Ответ ограничен безопасными лимитами размера и числа строк и сообщает конечный URL, исходный Content-Type и признак усечения.",
  ].join(" "),
  inputSchema: CONTROLLED_WEB_FETCH_INPUT_SCHEMA,
  async execute(input, ctx) {
    return await executeControlledWebFetch(input, { abortSignal: ctx.abortSignal });
  },
  // Preserve bounded content metadata so the model can assess redirects, representation, and truncation.
  toModelOutput(output) {
    return { type: "json", value: output };
  },
});
