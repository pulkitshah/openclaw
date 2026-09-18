/**
 * The two halves of the pairing-approval line, proven against the same router.
 *
 * DENY: a built-in agent tool dispatching `channels.pairing.approve` through its own funnel
 * (`src/agents/tools/in-process-gateway.ts`), which mints exactly the scopes the method asks for.
 *
 * ALLOW: the Team plugin reaching the same method internally through
 * `PluginRuntime.gateway.request` while servicing `team.add` — the shape
 * `approvePendingPairingRequests` uses on `feat/team-v2` @ `16ac6608f2`, and the one the agent-callable
 * `team_add` tool (`feat/team-v2-agent-tools` @ `bcd31013d6`) drives. That tool calls
 * `api.runtime.gateway.request("team.add", ...)`, so the whole chain runs on the plugin runtime
 * funnel and never through the agent funnel above. The nested case below is the load-bearing part: it
 * proves the agent-origin mark does not leak from an outer dispatch into a plugin's inner call.
 */
import { describe, expect, it, vi } from "vitest";
import {
  withPluginRuntimeGatewayRequestScope,
  withPluginRuntimePluginScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import type { AgentRuntimeIdentity } from "./agent-runtime-identity-token.js";
import { withInProcessAgentRuntimeIdentity } from "./in-process-agent-runtime-identity.js";
import { createCoreGatewayMethodDescriptors } from "./methods/core-descriptors.js";
import {
  createGatewayMethodDescriptorsFromHandlers,
  createGatewayMethodRegistry,
} from "./methods/registry.js";
import type { GatewayRequestContext, GatewayRequestHandler } from "./server-methods/types.js";
import { dispatchGatewayMethodInProcess } from "./server-plugin-in-process-dispatch.js";
import { dispatchTrustedPluginGatewayMethod } from "./server-plugins.js";

const TEAM_ADD_METHOD = "team.add";

function createContext(handlers: {
  approve: GatewayRequestHandler;
  teamAdd?: GatewayRequestHandler;
}): GatewayRequestContext {
  const methodRegistry = createGatewayMethodRegistry([
    ...createCoreGatewayMethodDescriptors({ "channels.pairing.approve": handlers.approve }),
    ...(handlers.teamAdd
      ? createGatewayMethodDescriptorsFromHandlers({
          handlers: { [TEAM_ADD_METHOD]: handlers.teamAdd },
          owner: { kind: "aux", area: "gateway-extra" },
          defaultScope: "operator.admin",
        })
      : []),
  ]);
  return {
    trackExecution: trackAsyncWork,
    getRuntimeConfig: () => ({}),
    getGatewayMethodRegistry: () => methodRegistry,
    logGateway: { error: vi.fn(), warn: vi.fn() },
  } as unknown as GatewayRequestContext;
}

const APPROVE_PARAMS = {
  channel: "whatsapp",
  accountId: "personal",
  requestId: "req-1",
  notify: true,
};

describe("channel pairing approval by request origin", () => {
  it("denies the agent's own funnel", async () => {
    const approve = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { ok: true }));
    const context = createContext({ approve });

    const call = withPluginRuntimeGatewayRequestScope(
      { context, isWebchatConnect: () => false },
      () =>
        dispatchGatewayMethodInProcess("channels.pairing.approve", APPROVE_PARAMS, {
          agentOriginated: true,
          forceSyntheticClient: true,
          operatorRoleActor: { kind: "system" as const },
          syntheticScopes: ["operator.pairing"],
        }),
    );

    await expect(call).rejects.toThrow(/not available to the agent/);
    expect(approve).not.toHaveBeenCalled();
  });

  it("denies a request carrying a verified agent runtime identity", async () => {
    const approve = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { ok: true }));
    const context = createContext({ approve });
    const identity = {
      kind: "agentRuntime",
      operationalRunInstance: { instanceId: "run-1" },
    } as unknown as AgentRuntimeIdentity;

    const call = withPluginRuntimeGatewayRequestScope(
      { context, isWebchatConnect: () => false },
      () =>
        dispatchGatewayMethodInProcess(
          "channels.pairing.approve",
          APPROVE_PARAMS,
          withInProcessAgentRuntimeIdentity(
            {
              forceSyntheticClient: true,
              operatorRoleActor: { kind: "system" as const },
              syntheticScopes: ["operator.pairing"],
            },
            identity,
          ),
        ),
    );

    await expect(call).rejects.toThrow(/not available to the agent/);
    expect(approve).not.toHaveBeenCalled();
  });

  it("allows the Team plugin's own inner call", async () => {
    const approve = vi.fn<GatewayRequestHandler>(({ respond }) =>
      respond(true, { approved: true }),
    );
    const context = createContext({ approve });

    const result = await withPluginRuntimeGatewayRequestScope(
      { context, isWebchatConnect: () => false, pluginId: "team", pluginOrigin: "bundled" },
      () =>
        dispatchTrustedPluginGatewayMethod("channels.pairing.approve", APPROVE_PARAMS, {
          scopes: ["operator.pairing"],
        }),
    );

    expect(result).toEqual({ approved: true });
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it("allows it nested inside an outer plugin dispatch, the team.add shape", async () => {
    const approve = vi.fn<GatewayRequestHandler>(({ respond }) =>
      respond(true, { approved: true }),
    );
    // Stands in for the `team.add` handler, which approves each matched pending request through the
    // plugin runtime before writing the roster projection. `withPluginRuntimePluginScope` is how a
    // plugin callable actually carries its identity in production — `PluginInstance.enter`
    // (`src/plugins/plugin-instance.ts:263-270`) wraps every one of them that way, and
    // `dispatchTrustedPluginGatewayMethod` reads the identity from that ambient scope.
    const teamAdd = vi.fn<GatewayRequestHandler>(async ({ respond }) => {
      const inner = await withPluginRuntimePluginScope(
        { pluginId: "team", pluginOrigin: "bundled" },
        () =>
          dispatchTrustedPluginGatewayMethod<{ approved?: boolean }>(
            "channels.pairing.approve",
            APPROVE_PARAMS,
            { scopes: ["operator.pairing"] },
          ),
      );
      respond(true, { member: "asha", pairing: inner });
    });
    const context = createContext({ approve, teamAdd });

    const result = await withPluginRuntimeGatewayRequestScope(
      { context, isWebchatConnect: () => false, pluginId: "team", pluginOrigin: "bundled" },
      () =>
        dispatchTrustedPluginGatewayMethod(
          TEAM_ADD_METHOD,
          { name: "Asha" },
          {
            scopes: ["operator.admin"],
          },
        ),
    );

    expect(result).toEqual({ member: "asha", pairing: { approved: true } });
    expect(approve).toHaveBeenCalledTimes(1);
  });
});
