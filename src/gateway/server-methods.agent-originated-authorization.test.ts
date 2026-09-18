/**
 * The Gateway-side boundary for the coordinator agent: it may not approve a channel pairing, which
 * admits a new person to instruct it, while a real operator and the sanctioned Team flow still can.
 *
 * These go through `handleGatewayRequest` on purpose — the fence is the router's, not a handler's, so
 * a test that called the handler directly would pass with the fence removed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import type { AgentRuntimeIdentity } from "./agent-runtime-identity-token.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayClient } from "./server-methods/client-types.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";

type Internal = NonNullable<GatewayClient["internal"]>;

function createClient(params: { scopes: string[]; internal?: Internal }): GatewayClient {
  return {
    connId: "conn-pairing",
    connect: {
      role: "operator",
      scopes: params.scopes,
      client: { id: "test", version: "1", platform: "test", mode: "test" },
      minProtocol: 1,
      maxProtocol: 1,
    },
    ...(params.internal ? { internal: params.internal } : {}),
  } as GatewayClient;
}

/**
 * Runs the real router with a stand-in handler for the requested method, so the scope policy under
 * test is the shipped one (`channels.pairing.approve` resolves `operator.pairing` dynamically) while
 * the assertion stays about authorization rather than pairing-store behavior.
 */
async function dispatch(params: { method: string; client: GatewayClient }) {
  const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { ok: true }));
  const respond = vi.fn();
  setActivePluginRegistry(createEmptyPluginRegistry());
  await handleGatewayRequest({
    req: { type: "req", id: "req-1", method: params.method, params: {} },
    respond,
    client: params.client,
    isWebchatConnect: () => false,
    context: { logGateway: { warn: vi.fn() } } as unknown as Parameters<
      typeof handleGatewayRequest
    >[0]["context"],
    extraHandlers: { [params.method]: handler },
  });
  return { handler, respond };
}

afterEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
});

describe("agent-originated gateway authorization", () => {
  it("denies an agent-originated channels.pairing.approve even with the pairing scope", async () => {
    const { handler, respond } = await dispatch({
      method: "channels.pairing.approve",
      client: createClient({
        scopes: ["operator.pairing"],
        internal: { syntheticClient: true, agentOriginated: true },
      }),
    });

    expect(handler).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "FORBIDDEN",
      message:
        "channels.pairing.approve is not available to the agent; a person has to decide this one",
      details: { code: "AGENT_ORIGIN_FORBIDDEN", method: "channels.pairing.approve" },
    });
  });

  it("denies it through the operator.admin wildcard too", async () => {
    const { handler, respond } = await dispatch({
      method: "channels.pairing.approve",
      client: createClient({
        scopes: ["operator.admin", "operator.pairing"],
        internal: { syntheticClient: true, agentOriginated: true },
      }),
    });

    expect(handler).not.toHaveBeenCalled();
    expect(respond.mock.calls[0]?.[2]).toMatchObject({ code: "FORBIDDEN" });
  });

  it("denies a worker that authenticated with its verified agent runtime identity", async () => {
    const { handler, respond } = await dispatch({
      method: "channels.pairing.approve",
      client: createClient({
        scopes: ["operator.pairing"],
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            operationalRunInstance: { instanceId: "run-1" },
          } as unknown as AgentRuntimeIdentity,
        },
      }),
    });

    expect(handler).not.toHaveBeenCalled();
    expect(respond.mock.calls[0]?.[2]).toMatchObject({ code: "FORBIDDEN" });
  });

  it("lets a genuine operator approve a channel pairing", async () => {
    const { handler, respond } = await dispatch({
      method: "channels.pairing.approve",
      client: createClient({ scopes: ["operator.pairing"] }),
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(true, { ok: true });
  });

  it("keeps the sanctioned Team write reachable for a real operator", async () => {
    const { handler, respond } = await dispatch({
      method: "team.add",
      client: createClient({ scopes: ["operator.admin"] }),
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(true, { ok: true });
  });

  it("still lets the agent read who is waiting to pair", async () => {
    const { handler } = await dispatch({
      method: "channels.pairing.list",
      client: createClient({
        scopes: ["operator.pairing"],
        internal: { syntheticClient: true, agentOriginated: true },
      }),
    });

    expect(handler).toHaveBeenCalledTimes(1);
  });
});
