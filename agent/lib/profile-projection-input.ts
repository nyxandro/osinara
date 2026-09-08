/** Shared input contract for profile policy execution and its approval presentation. */
import { z } from "zod";
import { AppError } from "./app-error.js";

export const profileProjectionInputSchema = z.object({
  action: z.enum(["list", "update"]).describe("list читает политики; update изменяет одну"),
  enabled: z.boolean().optional().describe("Обязательно только для action=update"),
  groupRef: z.string().regex(/^grp_[0-9a-f]{32}$/u).optional().describe("Обязательно для update; только из результата action=list"),
}).strict();

export function requireProfileProjectionUpdate(input: unknown): { enabled: boolean; groupRef: string } {
  const parsed = profileProjectionInputSchema.safeParse(input);
  if (!parsed.success || parsed.data.action !== "update" || parsed.data.enabled === undefined || parsed.data.groupRef === undefined) {
    throw new AppError("AGENT_PROFILE_PROJECTION_INPUT_INVALID", "Не удалось определить изменение переноса фактов. Обновите список групп и повторите запрос");
  }
  return { enabled: parsed.data.enabled, groupRef: parsed.data.groupRef };
}
