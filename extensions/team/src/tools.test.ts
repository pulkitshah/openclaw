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

/**
 * The host-built plugin tool context for one run, as `OpenClawPluginToolContext` carries it
 * (`src/agents/openclaw-tools.plugin-context.ts`). Only the three admission facts the owner gate
 * reads are modelled here; everything else a real context carries is irrelevant to it.
 *
 * `undefined` for all three is the shape a run with no inbound sender gets — a Duty/cron run, a
 * local CLI turn, a spawned subagent — and is the default below so a test that says nothing about
 * who is calling gets the fail-closed case rather than an accidental pass.
 */
type TurnContext = {
  messageChannel?: string;
  requesterSenderId?: string;
  agentAccountId?: string;
};

/** Accepts both registration shapes `registerTeamTools` uses: a plain tool object (`team_list`) and
 *  a run-bound factory (the three owner-gated tools), invoking the latter with `turn`. */
function collectTools(turn: TurnContext) {
  const tools = new Map<string, ExecutableTool>();
  return {
    tools,
    registerTool: (tool: unknown, opts?: { name?: string }) => {
      const resolved = (
        typeof tool === "function" ? (tool as (ctx: TurnContext) => unknown)(turn) : tool
      ) as ExecutableTool & { name?: string };
      tools.set(opts?.name ?? resolved.name ?? "", resolved);
    },
  };
}

/** A turn that arrives from a real person on a real channel. */
const turnFrom = (senderId: string, channel = "telegram"): TurnContext => ({
  messageChannel: channel,
  requesterSenderId: senderId,
});

/** Fake-response harness: proves a tool forwards the right method/params/scope and shapes its
 *  reply, without exercising the real Gateway method. Used for `team_list`, matching its existing
 *  test, and for cheap request-shape assertions on the new tools. */
function makeTools(params?: { respond?: (call: GatewayCall) => unknown; turn?: TurnContext }) {
  const collected = collectTools(params?.turn ?? turnFrom("111"));
  const calls: GatewayCall[] = [];
  const api = {
    registerTool: collected.registerTool,
    runtime: {
      gateway: {
        request: async (
          method: string,
          args: Record<string, unknown>,
          opts: { scopes: string[] },
        ) => {
          const call = { method, params: args, scopes: opts.scopes };
          calls.push(call);
          // These are request-shape tests, so the owner gate's own lookup is answered as the roster
          // would answer it for the owner; whether the gate itself holds is proved against the real
          // roster in the "owner gate" suites below, never here.
          return method === "team.identity.resolve"
            ? { member: { id: "owner", name: "Owner", role: "owner" }, ownerName: "Owner" }
            : (params?.respond?.(call) ?? {});
        },
      },
    },
    // SAFETY: this harness only ever receives this plugin's tools, each whose `execute` matches
    // ExecutableTool.
  } as never;
  registerTeamTools({ api });
  const run = async (name: string, input: unknown) =>
    JSON.parse((await collected.tools.get(name)!.execute("c1", input)).content[0]!.text);
  return { run, calls, tools: collected.tools };
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
function realHarness(params?: { config?: OpenClawConfig; turn?: TurnContext }) {
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

  // No turn facts by default: that is what a run with no inbound sender looks like, and a test that
  // does not say who is calling must get the fail-closed answer rather than a silent pass.
  const collected = collectTools(params?.turn ?? {});
  const toolApi = {
    registerTool: collected.registerTool,
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
    JSON.parse((await collected.tools.get(name)!.execute("c1", input)).content[0]!.text);
  return { run, store };
}

/** The owner's own channel identity, used by every real-harness roster below. */
const OWNER_IDENTITY = { channel: "telegram", senderId: "111", addedAt: 1 };
/** A plain member's identity: on the roster, so admitted to talk to Vasu, but not the owner. */
const MEMBER_IDENTITY = { channel: "telegram", senderId: "5551234", addedAt: 1 };

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
    // The gate's own roster lookup runs FIRST, then the mutation: proof of ordering, not just of
    // the forwarded shape.
    expect(calls[0]).toMatchObject({
      method: "team.identity.resolve",
      params: { channel: "telegram", senderId: "111" },
      scopes: ["operator.admin"],
    });
    expect(calls[1]).toMatchObject({
      method: "team.add",
      params: { name: "Ramesh", channels: [{ channel: "telegram", senderId: "5551234" }] },
      scopes: ["operator.admin"],
    });
    expect(out.member).toMatchObject({ id: "ramesh", name: "Ramesh", role: "member" });
    expect(out.pairingApproved).toEqual(["telegram"]);
    expect(JSON.stringify(out)).not.toContain("5551234");
  });

  it("performs the add through the real team.add handler and leaves the roster changed", async () => {
    const { run, store } = realHarness({ config: deskFixtureConfig(), turn: turnFrom("111") });
    await store.seedOwner({
      id: "owner",
      name: "Owner",
      addedBy: "owner",
      channels: [OWNER_IDENTITY],
    });

    const out = await run("team_add", {
      name: "Ramesh",
      channels: [{ channel: "telegram", senderId: "5551234" }],
    });

    expect(out.member).toMatchObject({ id: "ramesh", role: "member" });
    expect((await store.listMembers()).map((m) => m.id)).toEqual(["owner", "ramesh"]);
  });

  it("rejects and leaves the roster unchanged when the projection write fails mid-request", async () => {
    const { run, store } = realHarness({ config: deskFixtureConfig(), turn: turnFrom("111") });
    await store.seedOwner({
      id: "owner",
      name: "Owner",
      addedBy: "owner",
      channels: [OWNER_IDENTITY],
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
    expect(calls[0]?.method).toBe("team.identity.resolve");
    expect(calls[1]).toMatchObject({
      method: "team.remove",
      params: { memberId: "ramesh" },
      scopes: ["operator.admin"],
    });
    expect(out.removed).toMatchObject({ id: "ramesh", role: "member" });
    expect(JSON.stringify(out)).not.toContain("5551234");
  });

  it("performs the removal through the real team.remove handler", async () => {
    const { run, store } = realHarness({ turn: turnFrom("111") });
    await store.seedOwner({
      id: "owner",
      name: "Owner",
      addedBy: "owner",
      channels: [OWNER_IDENTITY],
    });
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
    const { run, store } = realHarness({ turn: turnFrom("111") });
    await store.seedOwner({
      id: "owner",
      name: "Owner",
      addedBy: "owner",
      channels: [OWNER_IDENTITY],
    });
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
    expect(calls[0]?.method).toBe("team.identity.resolve");
    expect(calls[1]).toMatchObject({
      method: "team.transferOwnership",
      params: { memberId: "ramesh" },
      scopes: ["operator.admin"],
    });
    expect(out.to).toMatchObject({ id: "ramesh", role: "owner" });
    expect(out.from).toMatchObject({ id: "owner", role: "member" });
    expect(JSON.stringify(out)).not.toContain("5551234");
  });

  it("performs the transfer through the real team.transferOwnership handler", async () => {
    const { run, store } = realHarness({ turn: turnFrom("111") });
    await store.seedOwner({
      id: "owner",
      name: "Owner",
      addedBy: "owner",
      channels: [OWNER_IDENTITY],
    });
    await store.addMember({ id: "ramesh", name: "Ramesh", addedBy: "owner", channels: [] });

    const out = await run("team_transfer_ownership", { memberId: "ramesh" });

    expect(out.to).toMatchObject({ id: "ramesh", role: "owner" });
    expect((await store.ownerMember())?.id).toBe("ramesh");
  });

  it("rejects and leaves both roles UNCHANGED when the projection write fails mid-request", async () => {
    const { run, store } = realHarness({ turn: turnFrom("111") });
    await store.seedOwner({
      id: "owner",
      name: "Owner",
      addedBy: "owner",
      channels: [OWNER_IDENTITY],
    });
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

/**
 * The owner gate, against the real roster and the real `team.*` handlers.
 *
 * Every refusal case below asserts the STORE, not just that the call threw: a gate that throws
 * after the write has landed would satisfy `rejects.toThrow` and still have admitted someone.
 */
describe("owner gate on the roster-mutating tools", () => {
  /** Owner (telegram 111) plus one ordinary member (telegram 5551234), both already admitted. */
  async function gatedDesk(turn: TurnContext) {
    const harness = realHarness({ config: deskFixtureConfig(), turn });
    await harness.store.seedOwner({
      id: "owner",
      name: "Radha",
      addedBy: "owner",
      channels: [OWNER_IDENTITY],
    });
    await harness.store.addMember({
      id: "ramesh",
      name: "Ramesh",
      addedBy: "owner",
      channels: [MEMBER_IDENTITY],
    });
    return harness;
  }

  /** Every roster row and role, as the store actually holds them right now. */
  const rosterState = async (store: Awaited<ReturnType<typeof gatedDesk>>["store"]) =>
    (await store.listMembers()).map((m) => `${m.id}:${m.role}`);

  const mutations: Array<{ tool: string; input: Record<string, unknown> }> = [
    {
      tool: "team_add",
      input: { name: "Sunita", channels: [{ channel: "telegram", senderId: "9999" }] },
    },
    { tool: "team_remove", input: { memberId: "ramesh" } },
    { tool: "team_transfer_ownership", input: { memberId: "ramesh" } },
  ];

  it.each(mutations)(
    "$tool refuses a roster member who is not the owner, and changes nothing",
    async ({ tool, input }) => {
      // Ramesh is a fully admitted Team member — this is exactly the case the gate exists for, not
      // an outsider who could never have reached Vasu in the first place.
      const { run, store } = await gatedDesk(turnFrom("5551234"));
      const before = await rosterState(store);

      const error = await run(tool, input).then(
        () => new Error("the tool did not refuse"),
        (reason: unknown) => (reason instanceof Error ? reason : new Error(String(reason))),
      );
      expect(error.message).toMatch(/Only the Team owner can change who is on/);
      // The refusal points at the owner by name, and at nobody by sender id.
      expect(error.message).toContain("Ask Radha");
      expect(error.message).not.toContain("111");
      expect(error.message).not.toContain("5551234");

      expect(await rosterState(store)).toEqual(before);
      expect(await store.getMember("sunita")).toBeUndefined();
    },
  );

  it.each(mutations)(
    "$tool refuses a turn with no identified sender, and changes nothing",
    async ({ tool, input }) => {
      // A Duty run, a cron turn, a spawned subagent, a local CLI turn: no inbound sender at all.
      // Omission is unknown and is never inferred into "probably the owner".
      const { run, store } = await gatedDesk({});
      const before = await rosterState(store);

      await expect(run(tool, input)).rejects.toThrow(/cannot tell who is asking/);

      expect(await rosterState(store)).toEqual(before);
      expect(await store.getMember("sunita")).toBeUndefined();
    },
  );

  it.each(mutations)(
    "$tool refuses a sender who is on no roster row at all, and changes nothing",
    async ({ tool, input }) => {
      const { run, store } = await gatedDesk(turnFrom("404404"));
      const before = await rosterState(store);

      await expect(run(tool, input)).rejects.toThrow(/Only the Team owner can change who is on/);

      expect(await rosterState(store)).toEqual(before);
    },
  );

  it.each(mutations)(
    "$tool refuses the owner's sender id arriving on a channel the owner is not on",
    async ({ tool, input }) => {
      // Two channels can legitimately issue the same bare id, so a roster identity only means
      // anything under its own channel key — matching must not fall back to a bare id compare.
      const { run, store } = await gatedDesk(turnFrom("111", "whatsapp"));
      const before = await rosterState(store);

      await expect(run(tool, input)).rejects.toThrow(/Only the Team owner can change who is on/);

      expect(await rosterState(store)).toEqual(before);
    },
  );

  it("lets the owner through, and the mutation lands", async () => {
    const { run, store } = await gatedDesk(turnFrom("111"));

    await run("team_remove", { memberId: "ramesh" });

    expect(await store.getMember("ramesh")).toBeUndefined();
  });

  it("recognizes the owner from any channel identity they hold, not just the first", async () => {
    // Task 1/2 bind every member with `session.dmScope: "per-peer"` and identity links, so one
    // person can write from Telegram today and WhatsApp tomorrow and still be one person.
    const { run, store } = realHarness({
      config: deskFixtureConfig(),
      turn: turnFrom("+919800000000", "whatsapp"),
    });
    await store.seedOwner({
      id: "owner",
      name: "Radha",
      addedBy: "owner",
      channels: [OWNER_IDENTITY, { channel: "whatsapp", senderId: "+919800000000", addedAt: 1 }],
    });
    await store.addMember({ id: "ramesh", name: "Ramesh", addedBy: "owner", channels: [] });

    await run("team_remove", { memberId: "ramesh" });

    expect(await store.getMember("ramesh")).toBeUndefined();
  });

  it("refuses when the owner's identity is scoped to a different account of the same channel", async () => {
    const { run, store } = realHarness({
      config: deskFixtureConfig(),
      turn: { messageChannel: "telegram", requesterSenderId: "111", agentAccountId: "personal" },
    });
    await store.seedOwner({
      id: "owner",
      name: "Radha",
      addedBy: "owner",
      channels: [{ channel: "telegram", senderId: "111", accountId: "work", addedAt: 1 }],
    });
    await store.addMember({ id: "ramesh", name: "Ramesh", addedBy: "owner", channels: [] });

    await expect(run("team_remove", { memberId: "ramesh" })).rejects.toThrow(
      /Only the Team owner can change who is on/,
    );
    expect(await store.getMember("ramesh")).toBeDefined();
  });

  it("names no owner when the roster has none yet", async () => {
    const { run } = realHarness({ turn: turnFrom("111") });

    await expect(run("team_remove", { memberId: "ramesh" })).rejects.toThrow(
      /no owner on the roster yet/,
    );
  });

  it("leaves team_list readable by an ordinary member", async () => {
    // The owner's explicit decision: everybody sees everything, only the roster writes are gated.
    const { run } = await gatedDesk(turnFrom("5551234"));

    const out = await run("team_list", {});

    expect(out.map((m: { id: string }) => m.id).toSorted()).toEqual(["owner", "ramesh"]);
  });
});
