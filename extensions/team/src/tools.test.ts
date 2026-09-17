import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it, vi, type Mock } from "vitest";
import { registerTeamGatewayMethods } from "./gateway-methods.js";
import { TeamStore } from "./store.js";
import { registerTeamTools } from "./tools.js";

/** Same reason `gateway-methods.test.ts` stubs this module: the tests below that exercise the real
 *  `team.*` handlers (via `realHarness`) must not touch `~/.openclaw/openclaw.json`. The stub still
 *  calls the caller's `assertStillAuthorized` exactly where the real implementation does, and can be
 *  told to reject to prove the tool entry point rolls back the same way a Team-page caller does. */
vi.mock("./team-write.js", () => ({
  writeTeamProjection: vi.fn(
    async (params: { members: unknown; assertStillAuthorized: () => void }) => {
      params.assertStillAuthorized();
      return { warnings: [], config: {} };
    },
  ),
  revokePairingEntries: vi.fn(async () => ({ warnings: [] })),
  approvePendingPairingRequests: vi.fn(async () => ({ approved: [] })),
}));

import { writeTeamProjection } from "./team-write.js";

type ExecutableTool = {
  execute: (id: string, input: unknown) => Promise<{ content: Array<{ text: string }> }>;
};

type GatewayCall = { method: string; params: Record<string, unknown>; scopes: string[] };

/** Fake-response harness: proves a tool forwards the right method/params/scope and shapes its
 *  reply, without exercising the real Gateway method. Used for `team_list`, matching its existing
 *  test, and for cheap request-shape assertions on the new tools. */
function makeTools(params?: { respond?: (call: GatewayCall) => unknown }) {
  const tools = new Map<string, ExecutableTool>();
  const calls: GatewayCall[] = [];
  const api = {
    registerTool: (tool: unknown, opts?: { name?: string }) => {
      const resolved = tool as ExecutableTool & { name?: string };
      tools.set(resolved.name ?? opts?.name ?? "", resolved);
    },
    runtime: {
      gateway: {
        request: async (
          method: string,
          args: Record<string, unknown>,
          opts: { scopes: string[] },
        ) => {
          const call = { method, params: args, scopes: opts.scopes };
          calls.push(call);
          return params?.respond?.(call) ?? {};
        },
      },
    },
    // SAFETY: this harness only ever receives this plugin's tools, each whose `execute` matches
    // ExecutableTool.
  } as never;
  registerTeamTools({ api });
  const run = async (name: string, input: unknown) =>
    JSON.parse((await tools.get(name)!.execute("c1", input)).content[0]!.text);
  return { run, calls, tools };
}

/** The smallest config that satisfies `assertTeamProjectionSafe` — copied from
 *  `gateway-methods.test.ts`'s own fixture of the same name, deliberately: each test file in this
 *  plugin keeps its own tiny fixture rather than sharing a test-only module. */
function deskFixtureConfig(): OpenClawConfig {
  return {
    agents: { ownership: "explicit", entries: { krishna: { name: "Krishna" } } },
    channels: {
      telegram: { enabled: true, dmPolicy: "allowlist", allowFrom: ["111"] },
      whatsapp: { enabled: true, dmPolicy: "allowlist", allowFrom: ["+919800000000"] },
    },
    bindings: [
      { agentId: "krishna", match: { channel: "telegram", accountId: "*" } },
      { agentId: "krishna", match: { channel: "whatsapp", accountId: "*" } },
    ],
    // SAFETY: a hand-built config fixture is a partial OpenClawConfig by construction.
  } as OpenClawConfig;
}

function memoryKeyed<T>() {
  const m = new Map<string, T>();
  return {
    register: async (k: string, v: T) => {
      m.set(k, v);
    },
    lookup: async (k: string) => m.get(k),
    entries: async () => [...m].map(([key, value]) => ({ key, value })),
    delete: async (k: string) => m.delete(k),
  };
}

/**
 * Wires `registerTeamTools` to the SAME `team.*` handler map `registerTeamGatewayMethods` builds,
 * mirroring the production dispatch path (`PluginRuntime.gateway.request` →
 * `dispatchTrustedPluginGatewayMethod` → `dispatchGatewayMethodInProcess` → the registered
 * handler), minus transport. This is what makes the "rejected write rolls back" tests below prove
 * something about the actual tool-call entry point, not just about `gateway-methods.ts` in
 * isolation (already covered by `gateway-methods.test.ts`).
 *
 * `hasCurrentClientAuthority` is deliberately left unset on every call here, because it is unset
 * for every in-process Team caller in production too (`server-plugin-in-process-dispatch.ts` never
 * sets it for a trusted plugin's own `runtime.gateway.request`; Duties' `adapters/deliver.ts` and
 * `team_list` itself already call in-process this same way). That is not a hole this task
 * introduces: the durable-write safety net for this entry point is `gateway-methods.ts`'s
 * catch-and-restore around `writeTeamProjection`, which does not depend on
 * `hasCurrentClientAuthority` at all — proved below by making `writeTeamProjection` reject.
 */
function realHarness(params?: { config?: OpenClawConfig }) {
  type Handler = (ctx: {
    params: Record<string, unknown>;
    respond: (ok: boolean, result?: unknown, error?: unknown) => void;
  }) => Promise<void>;
  const methods = new Map<string, Handler>();
  const gatewayApi = {
    registerGatewayMethod: (name: string, handler: Handler) => methods.set(name, handler),
    runtime: {},
    // SAFETY: `revokePairingEntries`/`approvePendingPairingRequests` (the only members of
    // `runtime` the real handlers touch) are mocked above, so this stub is never read.
  } as never;
  const store = new TeamStore({ team: memoryKeyed() });
  registerTeamGatewayMethods({
    api: gatewayApi,
    store,
    currentConfig: () => params?.config ?? {},
    safeEmit: vi.fn(),
  });

  const tools = new Map<string, ExecutableTool>();
  const toolApi = {
    registerTool: (tool: unknown, opts?: { name?: string }) => {
      const resolved = tool as ExecutableTool & { name?: string };
      tools.set(resolved.name ?? opts?.name ?? "", resolved);
    },
    runtime: {
      gateway: {
        request: async (method: string, args: Record<string, unknown>) =>
          new Promise((resolve, reject) => {
            const handler = methods.get(method);
            if (!handler) {
              reject(new Error(`no such Gateway method "${method}"`));
              return;
            }
            void handler({
              params: args,
              respond: (ok, result, error) =>
                ok
                  ? resolve(result)
                  : reject(
                      new Error(
                        isRecord(error) && typeof error.message === "string"
                          ? error.message
                          : String(error),
                      ),
                    ),
            });
          }),
      },
    },
    // SAFETY: this harness only ever receives this plugin's tools, each whose `execute` matches
    // ExecutableTool.
  } as never;
  registerTeamTools({ api: toolApi });
  const run = async (name: string, input: unknown) =>
    JSON.parse((await tools.get(name)!.execute("c1", input)).content[0]!.text);
  return { run, store };
}

describe("team_list", () => {
  it("returns names, ids, roles and channel names, never sender ids", async () => {
    const { run, calls } = makeTools({
      respond: ({ method }) =>
        method === "team.get"
          ? {
              members: [
                {
                  id: "ramesh",
                  name: "Ramesh",
                  role: "member",
                  addedBy: "owner",
                  addedAt: 1,
                  updatedAt: 1,
                  channels: [{ channel: "whatsapp", senderId: "+919812345678", addedAt: 1 }],
                },
              ],
            }
          : {},
    });
    const out = JSON.stringify(await run("team_list", {}));
    expect(calls[0]).toMatchObject({ method: "team.get", params: {}, scopes: ["operator.read"] });
    expect(out).toContain('"id":"ramesh"');
    expect(out).toContain('"channel":"whatsapp"');
    expect(out).not.toContain("+919812345678");
    expect(out).not.toContain("addedBy");
  });

  it("is registered by name", () => {
    const { tools } = makeTools();
    expect(tools.has("team_list")).toBe(true);
  });
});

describe("team_add", () => {
  it("calls team.add at operator.admin with the given name/channels", async () => {
    const { run, calls } = makeTools({
      respond: ({ method }) =>
        method === "team.add"
          ? {
              member: {
                id: "ramesh",
                name: "Ramesh",
                role: "member",
                addedBy: "owner",
                addedAt: 1,
                updatedAt: 1,
                channels: [{ channel: "telegram", senderId: "5551234", addedAt: 1 }],
              },
              warnings: [],
              pairingApproved: [{ channel: "telegram", senderId: "5551234", addedAt: 1 }],
            }
          : {},
    });
    const out = await run("team_add", {
      name: "Ramesh",
      channels: [{ channel: "telegram", senderId: "5551234" }],
    });
    expect(calls[0]).toMatchObject({
      method: "team.add",
      params: { name: "Ramesh", channels: [{ channel: "telegram", senderId: "5551234" }] },
      scopes: ["operator.admin"],
    });
    expect(out.member).toMatchObject({ id: "ramesh", name: "Ramesh", role: "member" });
    expect(out.pairingApproved).toEqual(["telegram"]);
    expect(JSON.stringify(out)).not.toContain("5551234");
  });

  it("performs the add through the real team.add handler and leaves the roster changed", async () => {
    const { run, store } = realHarness({ config: deskFixtureConfig() });
    await store.seedOwner({
      id: "owner",
      name: "Owner",
      addedBy: "owner",
      channels: [{ channel: "telegram", senderId: "111", addedAt: 1 }],
    });

    const out = await run("team_add", {
      name: "Ramesh",
      channels: [{ channel: "telegram", senderId: "5551234" }],
    });

    expect(out.member).toMatchObject({ id: "ramesh", role: "member" });
    expect((await store.listMembers()).map((m) => m.id)).toEqual(["owner", "ramesh"]);
  });

  it("rejects and leaves the roster unchanged when the projection write fails mid-request", async () => {
    const { run, store } = realHarness({ config: deskFixtureConfig() });
    await store.seedOwner({
      id: "owner",
      name: "Owner",
      addedBy: "owner",
      channels: [{ channel: "telegram", senderId: "111", addedAt: 1 }],
    });
    (writeTeamProjection as Mock).mockRejectedValueOnce(new Error("config write rejected"));

    await expect(
      run("team_add", {
        name: "Ramesh",
        channels: [{ channel: "telegram", senderId: "5551234" }],
      }),
    ).rejects.toThrow("config write rejected");

    expect((await store.listMembers()).map((m) => m.id)).toEqual(["owner"]);
  });
});

describe("team_remove", () => {
  it("calls team.remove at operator.admin with the given memberId", async () => {
    const { run, calls } = makeTools({
      respond: ({ method }) =>
        method === "team.remove"
          ? {
              removed: {
                id: "ramesh",
                name: "Ramesh",
                role: "member",
                addedBy: "owner",
                addedAt: 1,
                updatedAt: 1,
                channels: [{ channel: "telegram", senderId: "5551234", addedAt: 1 }],
              },
              warnings: [],
            }
          : {},
    });
    const out = await run("team_remove", { memberId: "ramesh" });
    expect(calls[0]).toMatchObject({
      method: "team.remove",
      params: { memberId: "ramesh" },
      scopes: ["operator.admin"],
    });
    expect(out.removed).toMatchObject({ id: "ramesh", role: "member" });
    expect(JSON.stringify(out)).not.toContain("5551234");
  });

  it("performs the removal through the real team.remove handler", async () => {
    const { run, store } = realHarness();
    await store.seedOwner({ id: "owner", name: "Owner", addedBy: "owner", channels: [] });
    await store.addMember({
      id: "ramesh",
      name: "Ramesh",
      addedBy: "owner",
      channels: [{ channel: "telegram", senderId: "5551234", addedAt: 1 }],
    });

    const out = await run("team_remove", { memberId: "ramesh" });

    expect(out.removed).toMatchObject({ id: "ramesh" });
    expect(await store.getMember("ramesh")).toBeUndefined();
  });

  it("rejects and leaves the roster UNCHANGED when the projection write fails mid-request", async () => {
    const { run, store } = realHarness();
    await store.seedOwner({ id: "owner", name: "Owner", addedBy: "owner", channels: [] });
    const ramesh = await store.addMember({
      id: "ramesh",
      name: "Ramesh",
      addedBy: "owner",
      channels: [{ channel: "telegram", senderId: "5551234", addedAt: 1 }],
    });
    (writeTeamProjection as Mock).mockRejectedValueOnce(new Error("config write rejected"));

    await expect(run("team_remove", { memberId: "ramesh" })).rejects.toThrow(
      "config write rejected",
    );

    // Not just "the call errored" — the roster row this call already deleted durably must be back,
    // exactly as it was, matching the known bug class this task preempts.
    expect(await store.getMember("ramesh")).toEqual(ramesh);
    expect((await store.listMembers()).map((m) => m.id).toSorted()).toEqual(["owner", "ramesh"]);
  });
});

describe("team_transfer_ownership", () => {
  it("calls team.transferOwnership at operator.admin with the given memberId", async () => {
    const { run, calls } = makeTools({
      respond: ({ method }) =>
        method === "team.transferOwnership"
          ? {
              from: {
                id: "owner",
                name: "Owner",
                role: "member",
                addedBy: "owner",
                addedAt: 1,
                updatedAt: 1,
                channels: [],
              },
              to: {
                id: "ramesh",
                name: "Ramesh",
                role: "owner",
                addedBy: "owner",
                addedAt: 1,
                updatedAt: 1,
                channels: [{ channel: "telegram", senderId: "5551234", addedAt: 1 }],
              },
              warnings: [],
            }
          : {},
    });
    const out = await run("team_transfer_ownership", { memberId: "ramesh" });
    expect(calls[0]).toMatchObject({
      method: "team.transferOwnership",
      params: { memberId: "ramesh" },
      scopes: ["operator.admin"],
    });
    expect(out.to).toMatchObject({ id: "ramesh", role: "owner" });
    expect(out.from).toMatchObject({ id: "owner", role: "member" });
    expect(JSON.stringify(out)).not.toContain("5551234");
  });

  it("performs the transfer through the real team.transferOwnership handler", async () => {
    const { run, store } = realHarness();
    await store.seedOwner({ id: "owner", name: "Owner", addedBy: "owner", channels: [] });
    await store.addMember({ id: "ramesh", name: "Ramesh", addedBy: "owner", channels: [] });

    const out = await run("team_transfer_ownership", { memberId: "ramesh" });

    expect(out.to).toMatchObject({ id: "ramesh", role: "owner" });
    expect((await store.ownerMember())?.id).toBe("ramesh");
  });

  it("rejects and leaves both roles UNCHANGED when the projection write fails mid-request", async () => {
    const { run, store } = realHarness();
    await store.seedOwner({ id: "owner", name: "Owner", addedBy: "owner", channels: [] });
    await store.addMember({ id: "ramesh", name: "Ramesh", addedBy: "owner", channels: [] });
    (writeTeamProjection as Mock).mockRejectedValueOnce(new Error("config write rejected"));

    await expect(run("team_transfer_ownership", { memberId: "ramesh" })).rejects.toThrow(
      "config write rejected",
    );

    // Not just "the call errored" — both roles this call already swapped durably must be back,
    // exactly as they were, matching the known bug class this task preempts.
    expect((await store.ownerMember())?.id).toBe("owner");
    expect((await store.getMember("ramesh"))?.role).toBe("member");
  });
});
