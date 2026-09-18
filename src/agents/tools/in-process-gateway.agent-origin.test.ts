/**
 * End-to-end proof for the agent's own Gateway funnel: a built-in agent tool dispatching
 * `channels.pairing.approve` in process is refused by the router, and the pairing handler never runs.
 *
 * The hand-built clients in `src/gateway/server-methods.agent-originated-authorization.test.ts` prove
 * the fence; this proves the real agent dispatch path actually reaches it.
 */
import { describe, expect, it, vi } from "vitest";
import { createCoreGatewayMethodDescriptors } from "../../gateway/methods/core-descriptors.js";
import { createGatewayMethodRegistry } from "../../gateway/methods/registry.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandler,
} from "../../gateway/server-methods/types.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import { callAgentToolGatewayRequest } from "./in-process-gateway.js";

function createContext(handler: GatewayRequestHandler): GatewayRequestContext {
  const methodRegistry = createGatewayMethodRegistry(
    createCoreGatewayMethodDescriptors({ "channels.pairing.approve": handler }),
  );
  return {
    trackExecution: trackAsyncWork,
    getRuntimeConfig: () => ({}),
    getGatewayMethodRegistry: () => methodRegistry,
    logGateway: { error: vi.fn(), warn: vi.fn() },
  } as unknown as GatewayRequestContext;
}

describe("built-in agent tool gateway dispatch", () => {
  it("cannot approve a channel pairing through the in-process router", async () => {
    const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { ok: true }));
    const context = createContext(handler);

    const call = withPluginRuntimeGatewayRequestScope(
      { context, isWebchatConnect: () => false },
      () =>
        callAgentToolGatewayRequest({
          method: "channels.pairing.approve",
          params: { channel: "whatsapp", accountId: "personal", requestId: "req" },
        }),
    );

    await expect(call).rejects.toThrow(/not available to the agent/);
    expect(handler).not.toHaveBeenCalled();
  });
});
