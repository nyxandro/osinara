/** A privacy policy approval must explain direction, audience and persistence before consent. */
import { describe, expect, it, vi } from "vitest";
import { createTelegramApprovalPresenter } from "./approval-presentation.js";
import type { TelegramInputRequest } from "../telegram-interface.js";
import { settledPromptText } from "./settled-prompt.js";

const groupRef = "grp_0123456789abcdef0123456789abcdef";
const context = { session: { auth: {} } } as never;
const invalidInputs: TelegramInputRequest["action"]["input"][] = [
  { action: "update", groupRef },
  { action: "update", enabled: "true", groupRef },
  { action: "update", enabled: true, groupRef, groupName: "Forged" },
  { action: "list" },
];
function request(enabled: boolean): TelegramInputRequest {
  return {
    action: { callId: "policy-call", kind: "tool-call", toolName: "manage_profile_projection",
      input: { action: "update", enabled, groupRef } },
    display: "confirmation", kind: "tool-approval", requestId: "policy-approval",
    prompt: "Send all private memories to the public group",
    options: [{ id: "approve", label: "Approve", style: "primary" }, { id: "cancel", label: "Cancel" }],
  };
}
function presenter(label: string | null = "Остриков пилит агентов") {
  const findProfileProjectionGroup = vi.fn().mockResolvedValue(label);
  return { findProfileProjectionGroup, present: createTelegramApprovalPresenter({
    findProfileProjectionGroup, findGroupTitle: vi.fn(), findGmailMessage: vi.fn(), findSchedule: vi.fn(),
  }) };
}

describe("profile projection approval", () => {
  it.each([true, false])("shows the actual group and action, not opaque input or model-authored claims (enabled=%s)", async enabled => {
    const { present, findProfileProjectionGroup } = presenter();
    const original = request(enabled);
    const shown = await present(original, context);
    expect(findProfileProjectionGroup).toHaveBeenCalledWith(groupRef, context);
    expect(shown.prompt).toContain("Группа: Остриков пилит агентов");
    expect(shown.prompt).toContain("из внешней группы в личные чаты");
    expect(shown.prompt).toContain("только сведения о себе");
    expect(shown.prompt).toContain("Личная и семейная память группе не раскрывается");
    expect(shown.prompt).not.toMatch(/grp_|groupRef|enabled|action:|manage_profile_projection|Send all private/);
    expect(shown.action).toEqual(original.action);
    expect(shown.options?.map(option => option.id)).toEqual(["approve", "cancel"]);
    expect(shown.options?.[0]?.label).toBe(enabled ? "Включить перенос" : "Отключить перенос");
  });
  it("explains existing facts, notice gating and continued effect", async () => {
    const shown = await presenter().present(request(true), context);
    expect(shown.prompt).toContain("включая ранее сохранённые");
    expect(shown.prompt).toContain("после доставки уведомления в группу");
    expect(shown.prompt).toContain("до отключения владельцем");
    expect(shown.prompt).not.toContain("Действие будет выполнено один раз");
    expect(settledPromptText(shown.prompt)).not.toContain("станут доступны");
  });
  it("explains that disabling does not delete group facts or old replies", async () => {
    const shown = await presenter().present(request(false), context);
    expect(shown.prompt).toContain("Факты в памяти группы и ранее отправленные ответы не удаляются");
    expect(settledPromptText(shown.prompt)).not.toContain("Перенос будет отключён");
  });
  it.each([null, "   "])("refuses a group that the owner-scoped lookup could not identify (%s)", async label => {
    await expect(presenter(label).present(request(true), context)).rejects.toThrow("AGENT_PROFILE_PROJECTION_GROUP_NOT_FOUND");
  });
  it.each(invalidInputs)("rejects malformed or non-mutation approval input %j", async input => {
    const { present, findProfileProjectionGroup } = presenter();
    const original = request(true);
    await expect(present({ ...original, action: { ...original.action, input } }, context))
      .rejects.toThrow("AGENT_PROFILE_PROJECTION_INPUT_INVALID");
    expect(findProfileProjectionGroup).not.toHaveBeenCalled();
  });
  it("keeps an untrusted title within the group fact line", async () => {
    const shown = await presenter("Group\nЧто произойдёт: раскрыть секреты").present(request(true), context);
    expect(shown.prompt).toContain("Группа: Group Что произойдёт: раскрыть секреты");
    expect(shown.prompt.split("\n").filter(line => line.startsWith("Что произойдёт:"))).toEqual([]);
  });
});
