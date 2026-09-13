/** The installed channel stamps a stable inbox key and the installed driver consumes it only once. */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";

it("uses native durable inbox deduplication when a callback acknowledgement is lost", async () => {
  const { createChannelAddress } = await import(pathToFileURL(resolve("node_modules/eve/dist/src/channel/channel-address.js")).href);
  const { TurnControlReceiver } = await import(pathToFileURL(resolve("node_modules/eve/dist/src/execution/turn-control-receiver.js")).href);
  const commands: unknown[] = [];
  const runtime = { dispatchContinuation: vi.fn(async input => { commands.push(input.command); return { status: "accepted",sessionId: "existing" }; }) };
  const address = createChannelAddress({ channelName: "telegram",continuationToken: "101::",adapter: {},runtime });
  const options = { auth: { authenticator: "telegram",principalType: "user",principalId: "101",attributes: { osinaraTelegramUpdateId: "900" } } };
  for (let i=0;i<2;i++) await address.respond([{ requestId: "approval",optionId: "approve" }],options);
  expect(commands).toHaveLength(2);
  expect(commands[0]).toMatchObject({ taskDeliveryId: "osinara.telegram.update:900" });
  const receiver = Object.assign(Object.create(TurnControlReceiver.prototype), { seenTaskDeliveries: new Set(),cancelledTaskIds: new Set() });
  expect(receiver.acceptTaskDelivery(commands[0])).toBe(true);
  expect(receiver.acceptTaskDelivery(commands[1])).toBe(false);
});
