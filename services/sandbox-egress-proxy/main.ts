/**
 * Sandbox egress proxy process entrypoint.
 *
 * Constructs:
 * - Starts the public-only forward proxy on the fixed internal port.
 */
import { createSandboxEgressProxy } from "./server.js";

const PROXY_PORT = 3128;

const server = createSandboxEgressProxy();
server.listen(PROXY_PORT, "0.0.0.0", () => {
  console.log("Sandbox egress proxy ready", { port: PROXY_PORT });
});
