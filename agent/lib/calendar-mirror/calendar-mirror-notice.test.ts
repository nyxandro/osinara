/**
 * Messages of the calendar mirror to the person.
 *
 * Constructs covered:
 * - A personal profile is told in its owner's private chat, the family one in every family group.
 * - Each kind of stop or refused edit has its plain Russian text with a stable code.
 * - A deleted calendar is offered back with one button; when Telegram refuses the message with the
 *   button, the words still go out without it.
 * - Every delivered message is recorded for the model's history; a failed one is logged, not retried.
 */
import { describe, expect, it, vi } from "vitest";

import type { CalendarMirrorProfile } from "./calendar-mirror-contract.js";
import { PROFILE } from "./calendar-mirror-fakes.test-support.js";
import { createCalendarMirrorNotices, type NoticeDependencies } from "./calendar-mirror-notice.js";

const NOW = new Date("2027-02-03T09:00:00Z");
const FAMILY: CalendarMirrorProfile = { ...PROFILE, ownerUserId: null, scope: "family", workspaceId: "workspace-family" };

function setup(options: { refuseRich?: boolean; sendFails?: boolean } = {}) {
  const sent: Array<{ body: Record<string, unknown>; method: string }> = [];
  const recorded: unknown[] = [];
  const staged: unknown[] = [];
  const activated: string[] = [];
  const discarded: string[] = [];
  const dependencies: NoticeDependencies = {
    async recipients(profile) {
      return profile.scope === "personal"
        ? [{ addresseeTelegramUserId: "111", chatId: "111", chatType: "private", groupId: null, ownerUserId: "user-1" }]
        : [
          { addresseeTelegramUserId: "111", chatId: "-1001", chatType: "supergroup", groupId: "group-1", ownerUserId: null },
          { addresseeTelegramUserId: "111", chatId: "-1002", chatType: "supergroup", groupId: "group-2", ownerUserId: null },
        ];
    },
    async recordDelivery(delivery) {
      recorded.push(delivery);
    },
    async send(method, body) {
      sent.push({ body, method });
      if (options.sendFails) throw new Error("network down");
      if (options.refuseRich && method === "sendRichMessage") return { body: { description: "Bad Request" }, ok: false, status: 400 };
      return { body: { result: { message_id: 500 + sent.length } }, ok: true, status: 200 };
    },
    buttons: {
      async activate(id, messageId) {
        activated.push(`${id}:${messageId}`);
      },
      async discard(id) {
        discarded.push(id);
      },
      async stage(input) {
        staged.push(input);
        return { id: "set-1", markdown: `${input.messageText}\n\n<tg-button-row>…</tg-button-row>` };
      },
    },
  };
  return { activated, dependencies, discarded, notices: createCalendarMirrorNotices(dependencies), recorded, sent, staged };
}

describe("calendar mirror notices", () => {
  it("tells the owner of a personal profile in the private chat and records it", async () => {
    const run = setup();
    await run.notices.send(PROFILE, { kind: "access_lost" }, NOW);
    expect(run.sent).toEqual([{
      body: {
        chat_id: "111",
        text: "Не могу вести напоминания в Google Календаре: доступ к Google истёк или был отозван. Напоминания в Telegram приходят как обычно. Чтобы вернуть календарь, напишите «подключи Google». Код: AGENT_CALENDAR_MIRROR_ACCESS_LOST",
      },
      method: "sendMessage",
    }]);
    expect(run.recorded).toEqual([expect.objectContaining({
      deliveredAt: NOW,
      familyId: "family-1",
      ownerUserId: "user-1",
      scope: "personal",
      sourceId: "workspace-1",
      sourceKind: "calendar_mirror_notice",
      telegramChatId: "111",
      telegramMessageId: "501",
    })]);
  });

  it("tells every family group with the family wording", async () => {
    const run = setup();
    await run.notices.send(FAMILY, { kind: "access_lost" }, NOW);
    expect(run.sent.map((message) => message.body.chat_id)).toEqual(["-1001", "-1002"]);
    expect(String(run.sent[0]!.body.text)).toContain("Владелец семьи может подключить Google заново в этой группе.");
    expect(run.recorded).toEqual([
      expect.objectContaining({ groupId: "group-1", scope: "family" }),
      expect.objectContaining({ groupId: "group-2", scope: "family" }),
    ]);
  });

  it.each([
    [{ kind: "calendar_refused" as const }, "Google не дал создать календарь «Осинара — напоминания», поэтому напоминаний в Google Календаре не будет. Напоминания в Telegram приходят как обычно. Код: AGENT_CALENDAR_MIRROR_CALENDAR_REFUSED"],
    [{ kind: "edit_unsupported" as const, reason: "instance" as const, title: "Йога" }, "В календаре вы изменили «Йога», но одно повторение из серии я пока менять не умею. Вернул как было. Напишите мне, что поменять, — сделаю. Код: AGENT_CALENDAR_EDIT_UNSUPPORTED"],
    [{ kind: "edit_unsupported" as const, reason: "recurrence" as const, title: "Йога" }, "В календаре вы изменили «Йога», но такой повтор я пока не умею: только каждый день, неделю, месяц или год. Вернул как было. Напишите мне, что поменять, — сделаю. Код: AGENT_CALENDAR_EDIT_UNSUPPORTED"],
    [{ kind: "edit_unsupported" as const, reason: "all_day" as const, title: "Йога" }, "В календаре вы изменили «Йога», но у напоминания должно быть время, а не весь день. Вернул как было. Напишите мне, что поменять, — сделаю. Код: AGENT_CALENDAR_EDIT_UNSUPPORTED"],
    [{ kind: "edit_unsupported" as const, reason: "past" as const, title: "Йога" }, "В календаре вы изменили «Йога», но это время уже прошло. Вернул как было. Напишите мне, что поменять, — сделаю. Код: AGENT_CALENDAR_EDIT_UNSUPPORTED"],
    [{ kind: "event_unsupported" as const, title: "Йога" }, "Событие «Йога» в календаре «Осинара — напоминания» повторяется так, как я пока не умею, поэтому напоминание по нему не поставил. Простые повторы — каждый день, неделю, месяц или год. Код: AGENT_CALENDAR_EVENT_UNSUPPORTED"],
    [{ kind: "settings_missing" as const }, "Чтобы присылать напоминания из календаря, мне нужен ваш часовой пояс. Напишите мне, например: «мой часовой пояс — Москва». Код: AGENT_NOTIFICATION_SETTINGS_REQUIRED"],
  ])("words %o", async (notice, text) => {
    const run = setup();
    await run.notices.send(PROFILE, notice, NOW);
    expect(run.sent[0]!.body.text).toBe(text);
  });

  it("offers a deleted calendar back with one button for the owner", async () => {
    const run = setup();
    await run.notices.send(PROFILE, { kind: "calendar_deleted" }, NOW);
    expect(run.staged).toEqual([expect.objectContaining({
      addresseeTelegramUserId: "111",
      buttons: [[{ text: "Вернуть календарь" }]],
      telegramChatId: "111",
      telegramChatType: "private",
    })]);
    expect(run.sent[0]!.method).toBe("sendRichMessage");
    expect(run.activated).toEqual(["set-1:501"]);
  });

  it("sends the words without the button when Telegram refuses the message carrying it", async () => {
    const run = setup({ refuseRich: true });
    await run.notices.send(PROFILE, { kind: "calendar_deleted" }, NOW);
    expect(run.sent.map((message) => message.method)).toEqual(["sendRichMessage", "sendMessage"]);
    expect(run.discarded).toEqual(["set-1"]);
    expect(String(run.sent[1]!.body.text)).toContain("напишите мне «верни календарь»");
    expect(run.recorded).toHaveLength(1);
  });

  it("logs a failed delivery and does not retry it", async () => {
    const run = setup({ sendFails: true });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(run.notices.send(PROFILE, { kind: "access_lost" }, NOW)).resolves.toBeUndefined();
    expect(run.sent).toHaveLength(1);
    expect(run.recorded).toEqual([]);
    expect(error.mock.calls.map(([line]) => JSON.parse(String(line)).code)).toContain("AGENT_CALENDAR_MIRROR_NOTICE_FAILED");
    error.mockRestore();
  });
});
