/**
 * Telegram enrollment boundary tests.
 *
 * Constructs covered:
 * - `handleTelegramEnrollmentBoundary`: accepts exact bootstrap commands without model dispatch.
 * - Ordinary private text cannot consume a bootstrap attempt.
 * - Existing identities cannot turn invitation deep links into conversation content.
 */
import { describe, expect, it, vi } from "vitest";

import { handleTelegramEnrollmentBoundary } from "./telegram-enrollment-boundary.js";
import {
  privateMessage,
  repositories,
  telegramContext,
} from "./telegram-on-message.test-fixtures.js";

describe("handleTelegramEnrollmentBoundary", () => {
  it("claims an owner only from the exact bootstrap command", async () => {
    const repository = repositories();
    const code = "a".repeat(43);
    repository.telegram.hasOwner.mockResolvedValue(false);
    repository.telegram.claimFirstOwner.mockResolvedValue("claimed");
    const { context, sendMessage } = telegramContext();

    const consumed = await handleTelegramEnrollmentBoundary({
      ctx: context,
      identity: null,
      invitationCode: null,
      message: privateMessage(`/start ${code}`),
      repositories: repository,
    });

    expect(consumed).toBe(true);
    expect(repository.telegram.claimFirstOwner).toHaveBeenCalledWith(code, {
      displayName: "Анна",
      telegramUserId: "telegram-101",
      username: "anna",
    });
    expect(sendMessage).toHaveBeenCalledWith(
      "Владелец создан. Семейный агент готов к настройке.",
    );
  });

  it("does not spend bootstrap attempts on ordinary private text", async () => {
    const repository = repositories();
    repository.telegram.hasOwner.mockResolvedValue(false);
    const { context, sendMessage } = telegramContext();

    const consumed = await handleTelegramEnrollmentBoundary({
      ctx: context,
      identity: null,
      invitationCode: null,
      message: privateMessage("привет"),
      repositories: repository,
    });

    expect(consumed).toBe(true);
    expect(repository.telegram.claimFirstOwner).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      "AGENT_BOOTSTRAP_COMMAND_INVALID: Откройте одноразовую ссылку владельца, полученную на сервере.",
    );
  });

  it("welcomes a guest who opened a guest link and tells the inviting owner", async () => {
    const repository = repositories();
    repository.telegram.hasOwner.mockResolvedValue(true);
    repository.family.claimInvitation.mockResolvedValue({ guest: "joined", hostOwnerTelegramUserId: "owner-77" });
    const { context, sendMessage } = telegramContext();
    const request = vi.fn().mockResolvedValue({ ok: true });
    Object.assign(context.telegram, { request });

    const consumed = await handleTelegramEnrollmentBoundary({
      ctx: context,
      identity: null,
      invitationCode: "g".repeat(32),
      message: privateMessage(`/start ${"g".repeat(32)}`),
      repositories: repository,
    });

    expect(consumed).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(
      "Готово, вы подключены к агенту как гость. Пишите сюда — я помогу с поиском, файлами, напоминаниями и другими задачами. Ваша память отдельная и не пересекается с памятью других людей.",
    );
    expect(request).toHaveBeenCalledWith("sendMessage", {
      chat_id: "owner-77",
      text: "Гость подключился по вашей ссылке: Анна (@anna). Посмотреть гостей, выключить им инструменты и скиллы или закрыть доступ можно здесь, в личном чате со мной.",
    });
  });

  it("welcomes a removed guest back and keeps the join when Telegram refuses the owner's notice", async () => {
    const repository = repositories();
    repository.telegram.hasOwner.mockResolvedValue(true);
    repository.family.claimInvitation.mockResolvedValue({ guest: "returned", hostOwnerTelegramUserId: "owner-77" });
    const { context, sendMessage } = telegramContext();
    Object.assign(context.telegram, { request: vi.fn().mockResolvedValue({ body: {}, ok: false, status: 403 }) });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const consumed = await handleTelegramEnrollmentBoundary({
      ctx: context,
      identity: null,
      invitationCode: "g".repeat(32),
      message: privateMessage(`/start ${"g".repeat(32)}`),
      repositories: repository,
    });

    expect(consumed).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(
      "С возвращением! Доступ к агенту снова открыт: ваша память и файлы на месте, а напоминания и сценарии стоят на паузе — попросите меня их возобновить.",
    );
    expect(logged.mock.calls.some(([line]) => String(line).includes("AGENT_GUEST_JOIN_OWNER_NOTICE_FAILED"))).toBe(true);
    logged.mockRestore();
  });

  it("tells a former guest plainly that a guest cannot join the family yet", async () => {
    const repository = repositories();
    repository.telegram.hasOwner.mockResolvedValue(true);
    repository.family.claimInvitation.mockResolvedValue("former_guest");
    const { context, sendMessage } = telegramContext();

    await handleTelegramEnrollmentBoundary({
      ctx: context,
      identity: null,
      invitationCode: "f".repeat(32),
      message: privateMessage(`/start ${"f".repeat(32)}`),
      repositories: repository,
    });

    expect(sendMessage).toHaveBeenCalledWith(
      "AGENT_INVITATION_FORMER_GUEST: Вы были гостем этого агента, а гостя пока нельзя перевести в семью. Сообщите об этом владельцу.",
    );
  });

  it("consumes an existing member invitation without claiming it", async () => {
    const repository = repositories();
    const { context, sendMessage } = telegramContext();

    const consumed = await handleTelegramEnrollmentBoundary({
      ctx: context,
      identity: { familyId: "family-1", role: "member", userId: "user-1" },
      invitationCode: "a".repeat(32),
      message: privateMessage(`/start ${"a".repeat(32)}`),
      repositories: repository,
    });

    expect(consumed).toBe(true);
    expect(repository.family.claimInvitation).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      "AGENT_INVITATION_NOT_APPLICABLE: Вы уже подключены к агенту.",
    );
  });
});
