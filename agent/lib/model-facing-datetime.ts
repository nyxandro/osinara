/**
 * Model-facing ISO datetime field.
 *
 * Export:
 * - `isoDateTimeWithOffset`: accepts exactly what `z.iso.datetime({ offset: true })` accepts.
 *
 * Zod renders that check as a pattern of almost three hundred characters in the JSON schema that
 * every model request carries. The model reads `format: date-time` and the example in the
 * description instead, while the same check still runs on the value it sends.
 */
import { z } from "zod";

const ISO_DATETIME_WITH_OFFSET = z.iso.datetime({ offset: true });

export function isoDateTimeWithOffset(description: string) {
  return z.string()
    .refine((value) => ISO_DATETIME_WITH_OFFSET.safeParse(value).success, {
      message: "Ожидается ISO 8601 datetime с UTC offset, например 2026-07-31T16:00:00Z",
    })
    .meta({ format: "date-time" })
    .describe(description);
}
