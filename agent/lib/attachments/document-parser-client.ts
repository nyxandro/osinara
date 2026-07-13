/**
 * Isolated document-parser service client.
 *
 * Exports:
 * - `RenderedPdfPage`, `RenderedPdfPages`: validated page-rendering contract.
 * - `createDocumentParserClient`: dependency-injected HTTP client for tests.
 * - `documentParserClient`: production client for the private Docker service.
 */
import { z } from "zod";

import {
  DOCUMENT_PARSER_BASE_URL,
  DOCUMENT_PARSER_TIMEOUT_MS,
  WORKSPACE_PDF_VISION_PAGES_PER_CALL,
} from "../../config.js";
import { AppError } from "../app-error.js";

const renderedPagesSchema = z.object({
  pages: z.array(z.object({
    contentBase64: z.string().min(1),
    pageNumber: z.number().int().positive(),
  })).min(1).max(WORKSPACE_PDF_VISION_PAGES_PER_CALL),
  totalPages: z.number().int().positive(),
});

export interface RenderedPdfPage {
  bytes: Buffer;
  pageNumber: number;
}

export interface RenderedPdfPages {
  pages: RenderedPdfPage[];
  totalPages: number;
}

export function createDocumentParserClient(input: {
  baseUrl: string;
  fetchImplementation?: typeof fetch;
  timeoutMs: number;
}) {
  return {
    async renderPdfPages(request: {
      bytes: Uint8Array;
      startPage: number;
    }): Promise<RenderedPdfPages> {
      const fetchImplementation = input.fetchImplementation ?? fetch;
      let response: Response;
      try {
        response = await fetchImplementation(`${input.baseUrl}/render-pdf`, {
          body: Buffer.from(request.bytes),
          headers: {
            "content-type": "application/pdf",
            "x-start-page": String(request.startPage),
          },
          method: "POST",
          signal: AbortSignal.timeout(input.timeoutMs),
        });
      } catch (error) {
        console.error(JSON.stringify({
          code: "AGENT_DOCUMENT_PARSER_UNAVAILABLE",
          errorName: error instanceof Error ? error.name : "UnknownError",
        }));
        throw new AppError(
          "AGENT_DOCUMENT_PARSER_UNAVAILABLE",
          "Сервис разбора документов временно недоступен. Попробуйте позже",
        );
      }
      if (!response.ok) {
        console.error(JSON.stringify({
          code: "AGENT_DOCUMENT_RENDER_FAILED",
          parserStatus: response.status,
        }));
        throw new AppError(
          "AGENT_DOCUMENT_RENDER_FAILED",
          "Не удалось подготовить страницы PDF для просмотра. Проверьте файл",
        );
      }
      const parsed = renderedPagesSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new AppError(
          "AGENT_DOCUMENT_PARSER_RESPONSE_INVALID",
          "Сервис разбора документов вернул некорректный результат",
        );
      }
      return {
        pages: parsed.data.pages.map((page) => ({
          bytes: Buffer.from(page.contentBase64, "base64"),
          pageNumber: page.pageNumber,
        })),
        totalPages: parsed.data.totalPages,
      };
    },
  };
}

export const documentParserClient = createDocumentParserClient({
  baseUrl: DOCUMENT_PARSER_BASE_URL,
  timeoutMs: DOCUMENT_PARSER_TIMEOUT_MS,
});
