/** Stable identity of a configured model connection, without persisting URLs or credentials. */
import { createHash } from "node:crypto";
import type { AgentModelTransport } from "./model-provider-config.js";

export function modelRouteKey(transport: AgentModelTransport, modelId: string): string {
  return createHash("sha256").update(JSON.stringify({
    baseUrl: new URL(transport.baseUrl).href,
    modelId,
    protocol: transport.protocol,
    provider: transport.protocol === "anthropic-messages" ? "anthropic" : transport.providerName,
  })).digest("hex");
}
