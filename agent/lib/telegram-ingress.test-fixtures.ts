/** Simulate the native adapter's ingress coordinate when a unit test replaces dispatch. */
import type { TelegramDrainContext } from "eve/channels/telegram";

export function correlatedDispatch(dispatch: TelegramDrainContext["dispatch"]): TelegramDrainContext["dispatch"] {
  return async (update, control) => {
    const session = await dispatch(update, control);
    if (!session) return session;
    if (!control) throw new Error("TEST_INGRESS_CONTROL_MISSING");
    return {
      ...session,
      async getEventStream(options) {
        return (await session.getEventStream(options)).pipeThrough(new TransformStream({
          transform(event, controller) {
            const correlated = { ...event, data: { ...("data" in event ? event.data : {}), osinaraTelegramIngressId: control.dispatchId } };
            controller.enqueue(correlated as typeof event);
          },
        }));
      },
    };
  };
}
